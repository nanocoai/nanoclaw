# Nostr Signer Sessions — Scoped Signing for Your AI Agent

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

**Feeling stuck? Ask Claude directly where you are in the process and what to do next.**

---

## What You're Learning About

Your NanoClaw agent signs Nostr events (posts, zaps, badge awards, DMs) using a signing daemon that holds your private key in kernel memory. The agent never sees the key — it just asks the daemon to sign things.

Until now, the daemon signed whatever the agent asked, with no limits. That worked, but it meant a compromised container could request unlimited signatures for any event type.

**Sessions** fix this. They're short-lived permission slips that tell the daemon exactly what the agent is allowed to sign, for how long, and how often.

Think of it like giving someone your car keys vs. giving them a valet ticket. The valet ticket works for one trip, for one car, and expires when they're done.

---

## What You're Setting Up

Nothing — it's already running. The signing daemon now supports sessions automatically. What you're learning here is:

1. How sessions work (so you understand what's protecting your key)
2. How to create one manually (for testing or debugging)
3. What happens when something goes wrong (rate limits, scope violations)
4. How your agent should use sessions going forward

---

## The Three Security Layers

### Layer 1: Session Tokens

A session token is a random string that grants permission to sign specific event types for a limited time.

| What you want to do | What it means |
|---------------------|---------------|
| Create a session | Tell the daemon "allow signing kind:1 and kind:9734 for the next 8 hours" |
| Use a session | Include the token with every signing request |
| Revoke a session | Immediately invalidate the token — no more signing |

**Scoped event kinds:** Each session only allows specific Nostr event types:

| Kind | What it is | Risk level |
|------|-----------|------------|
| 1 | Public notes (posts) | Low — visible but not dangerous |
| 1111 | Subclaw comments (NIP-22) | Low |
| 9734 | Zap requests (Lightning payments) | Medium — involves money |
| 8 | Badge awards | Medium — permanent credentials |
| 0 | Profile updates | High — changes your identity |
| 30009 | Badge definitions | High — creates new badge types |

A session scoped to `[1, 1111]` can post notes and subclaw comments but cannot send zaps, award badges, or change the profile. If a container is compromised, the attacker can only do what the session allows.

### Layer 2: Rate Limiting

Even within a valid session, the daemon limits how fast the agent can sign:

| Limit | Default | Why |
|-------|---------|-----|
| 5 per 10 seconds | Burst protection | Prevents rapid-fire spam |
| 10 per minute | Normal pace | More than enough for real agent work |
| 100 per hour | Safety ceiling | No legitimate agent needs more |

If a limit is hit, the request is rejected and logged. The agent gets a clear error message. Nothing breaks — it just has to wait.

### Layer 3: Backwards Compatibility

If you don't use sessions yet, everything still works exactly as before. The daemon logs a deprecation warning the first time it sees a request without a session token, but it signs the event normally. This means:

- Your existing tools (clawstr-post, badge-claim-listener, etc.) keep working
- You can migrate to sessions gradually
- Nothing breaks on upgrade

---

## How to Test It Yourself

Open a terminal on the machine where NanoClaw runs. These commands talk directly to the signing daemon.

### Create a session

```bash
echo '{"method":"session_start","params":{"scope":"1,1111","ttl":"3600"}}' \
  | nc -U $XDG_RUNTIME_DIR/nostr-signer.sock -w 2
```

You'll get back something like:
```json
{
  "session": {
    "token": "ff5ec525...a long random string...",
    "expiresAt": 1775111845270,
    "allowedKinds": [1, 1111]
  }
}
```

**What this did:** Created a session that allows signing kind:1 (posts) and kind:1111 (subclaw comments) for 1 hour (3600 seconds). Save the token — you'll need it for the next steps.

### Sign an event with the session

```bash
echo '{"method":"sign_event","params":{
  "kind": 1,
  "content": "Hello from a scoped session",
  "tags": [],
  "session_token": "YOUR_TOKEN_HERE"
}}' | nc -U $XDG_RUNTIME_DIR/nostr-signer.sock -w 2
```

**What happens:** The daemon checks the token, confirms kind:1 is in scope, checks rate limits, and signs the event. You get back a fully signed Nostr event.

### Try signing something NOT in scope

```bash
echo '{"method":"sign_event","params":{
  "kind": 0,
  "content": "profile update attempt",
  "tags": [],
  "session_token": "YOUR_TOKEN_HERE"
}}' | nc -U $XDG_RUNTIME_DIR/nostr-signer.sock -w 2
```

**What happens:** The daemon rejects it:
```json
{"error": "Event kind 0 not in session scope [1, 1111]"}
```

The rejection is also logged to `~/NanoClaw/groups/main/status/signer-alerts.log` so you can see what was attempted.

### Check session status

```bash
echo '{"method":"session_info","params":{"token":"YOUR_TOKEN_HERE"}}' \
  | nc -U $XDG_RUNTIME_DIR/nostr-signer.sock -w 2
```

Returns how many times the session has been used, whether it's expired, and current rate stats.

### Revoke a session

```bash
echo '{"method":"session_revoke","params":{"token":"YOUR_TOKEN_HERE"}}' \
  | nc -U $XDG_RUNTIME_DIR/nostr-signer.sock -w 2
```

**What happens:** The token is immediately invalid. Any future signing request using it will be rejected. Use this when a container session ends, or if you suspect something is wrong.

---

## What the Alert Log Looks Like

When the daemon rejects a request, it writes to:
```
~/NanoClaw/groups/main/status/signer-alerts.log
```

Example entries:
```
2026-04-02T05:37:39Z sign_event rejected: Event kind 0 not in session scope [1,9734] (kind=0, token=ff5ec525...)
2026-04-02T05:38:07Z sign_event rate-limited: Rate limit: burst exceeded (5/5 in 10s) (token=ff5ec525...)
```

If you see entries you didn't expect, that's worth investigating — it could mean a tool is misconfigured, or something is trying to use the signing daemon in a way it shouldn't.

---

## How Your Agent Should Use Sessions

Right now, your agent's tools (clawstr-post, badge-claim-listener, etc.) use legacy mode — they sign without a session token. This still works.

The recommended migration path:

1. **Don't rush.** Legacy mode is safe for now. The daemon logs a deprecation warning but signs normally.
2. **When you customize a tool**, add session support at that point. Create a session at startup, pass the token with each signing request, revoke it on shutdown.
3. **For high-risk operations** (zaps, profile updates), sessions add real protection. A session scoped to `[9734]` with a 1-hour TTL means even a compromised container can only send zap requests — and only for an hour.
4. **For NanoClaw container startup**, the orchestrator (`src/container-runner.ts`) is the natural place to create a session and pass the token to the container as an environment variable.

---

## Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| "Invalid session token" | Token doesn't exist or was revoked | Create a new session with `session_start` |
| "Session expired" | TTL ran out | Create a new session — the old one is gone |
| "Event kind X not in session scope" | The session doesn't allow this event type | Create a new session with the needed kind in the scope, or use legacy mode |
| "Rate limit: burst exceeded" | Too many requests too fast | Wait 10 seconds and try again. If this keeps happening, something is looping. |
| "Rate limit: N/10 per minute" | Hit the per-minute ceiling | Wait a minute. If legitimate, consider whether your tool is signing too often. |
| Legacy deprecation warning in logs | Tool signing without a session token | Not urgent — works fine. Migrate when convenient. |
| Alert log has entries you don't recognize | Something unexpected tried to sign | Check which tool or process made the request. Could be a misconfigured tool or something worth investigating. |

---

## Files Created by This Feature

| File | What it does |
|------|-------------|
| `tools/nostr-signer/index.js` | Main daemon — now includes session validation and rate limiting |
| `tools/nostr-signer/sessions.js` | Session token management (create, validate, revoke, persist to disk) |
| `tools/nostr-signer/rate-limiter.js` | Sliding window rate limiter (burst, per-minute, per-hour) |
| `~/.config/nanoclaw/signer-sessions.json` | Active sessions persisted to disk (survives daemon restart) |
| `~/NanoClaw/groups/main/status/signer-alerts.log` | Rejection and rate-limit alerts |

---

## Why This Matters

Most AI agent systems give the agent unlimited access to whatever credentials it needs. If the agent is compromised, everything it can access is compromised.

Sessions are a different model: the agent gets a temporary, scoped permission slip that limits what it can do and for how long. The private key stays in kernel memory on the host. The session token is the only thing the container touches — and it can only sign what the session allows.

No implementation of this pattern exists anywhere else in the Nostr ecosystem. This is the first signing daemon with per-session scoping and rate limiting. It was built because Scott asked a simple question: "What happens if the container gets hacked?" The answer used to be "they can sign anything forever." Now the answer is "they can sign what the session allows, at the rate we set, for the time we choose — and every rejection is logged."

That's the difference between trusting your agent and verifying your agent.
