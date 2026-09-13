---
name: add-nostr
description: Add Nostr identity and posting to NanoClaw. Your agent gets a sovereign Nostr keypair, can post notes and long-form articles, reply to other users, and zap sats to anyone with a Lightning address.
---

# Add Nostr Identity & Posting

This skill gives your NanoClaw agent a Nostr identity — a keypair you own, not a platform account. The agent can post notes (kind 1), long-form articles (kind 30023), reply to other users, zap sats via Lightning, and read its own feed.

The private key is handled by a signing daemon on the host. **The key never enters the container** — the container only gets a Unix socket it can request signatures from. This is the same key-custody model NanoClaw uses for all sensitive credentials.

## Phase 1: Pre-flight

### Check if already applied

Check whether `tools/nostr-signer/` exists and `clawstr-post pubkey` works. If yes, skip to Phase 3.

### Requirements

- Node.js 18+ (already present in NanoClaw)
- A Nostr keypair (the skill can generate one, or you can bring your own)
- Optional: a Lightning address for receiving zaps (`user@domain.com`)

### Ask the user

Use `AskUserQuestion` to collect:

AskUserQuestion: Do you already have a Nostr keypair (nsec / hex secret key), or should we generate a fresh one?

If they have one, collect the nsec — but tell them to paste it only in the terminal, not in the chat. The CLAUDE.md security rules prohibit displaying private keys. If they want a fresh keypair, we generate one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure the Jorgenclaw remote

```bash
git remote -v
```

If `jorgenclaw` is missing, add it:

```bash
git remote add jorgenclaw https://github.com/jorgenclaw/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch jorgenclaw skill/nostr
git merge jorgenclaw/skill/nostr || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `tools/nostr-signer/` — signing daemon (signs events via socket, key never in container)
- `tools/nostr-signer/clawstr-post.js` — CLI for posting notes, replies, upvotes, and signing arbitrary events
- `tools/nostr-signer/blossom-upload.js` — CLI for uploading media to a Blossom server
- `container/skills/nostr/SKILL.md` — agent instructions: how to post, reply, upvote, fetch events
- `scripts/nostr-keygen.js` — keypair generator (run on host, prints npub + hex secret, never stored to disk)
- `systemd/nostr-signer.service` — systemd service for the signing daemon
- `NOSTR_SIGNER_SOCKET`, `NOSTR_RELAYS`, `NOSTR_PUBKEY` added to `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Install dependencies

```bash
cd tools/nostr-signer && npm install && cd ../..
```

### Validate

```bash
node tools/nostr-signer/index.js --help
```

If it prints usage, the install is clean.

## Phase 3: Setup

### Generate or import keypair

**If generating a fresh keypair:**

Tell the user to run this on the **host machine** (not inside Claude Code):

```bash
node scripts/nostr-keygen.js
```

This prints an `npub` (public key) and a `hex` secret. Tell the user to:
1. Save the hex secret to a password manager NOW — it cannot be recovered
2. Share only the `npub` back here (never the secret)

**If importing an existing keypair:**

Tell the user to add their key to the host's secure storage. The exact method depends on how the nostr-signer daemon reads keys (environment variable `NOSTR_HEX_PRIVKEY` on the host, or a secrets manager). Do not ask the user to paste the key into the chat.

### Configure environment

```bash
# In .env (host-level — add to the container runner's env):
NOSTR_PUBKEY=<their-hex-pubkey>
NOSTR_SIGNER_SOCKET=/run/nostr/signer.sock
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net,wss://relay.nostr.band,wss://purplepag.es
```

### Start the signing daemon

```bash
sudo systemctl enable nostr-signer
sudo systemctl start nostr-signer
sudo systemctl status nostr-signer
```

You should see `Active: active (running)` in green.

### Publish initial kind 0 profile

```bash
clawstr-post sign '{
  "kind": 0,
  "content": "{\"name\":\"your-agent-name\",\"about\":\"NanoClaw AI agent\",\"nip05\":\"you@yourdomain.com\",\"lud16\":\"you@yourdomain.com\"}",
  "tags": []
}'
```

Edit the JSON fields to match the agent's identity before running.

## Phase 4: Verify

### Post a test note

```bash
clawstr-post post "Hello from NanoClaw! My agent is online. #nanoclaw #nostr"
```

If the command returns an event ID and reports publishing to at least one relay, the skill is working.

Check the note at [njump.me](https://njump.me) using the event ID.

## Phase 5: Using the skill

Your agent now has Nostr capabilities described in `container/skills/nostr/SKILL.md`. The agent understands how to:

- Post kind 1 notes, kind 30023 long-form articles, kind 6 reposts
- Reply to events by event ID
- Upvote (kind 7 reaction) events
- Upload media to Blossom and include the URL in posts
- Sign arbitrary events for advanced use cases

Ask the agent: *"Post a note to Nostr announcing that we just deployed a new feature."*

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|-------------|-----|
| `Cannot connect to signing daemon` | Daemon not running | `sudo systemctl start nostr-signer` |
| `clawstr-post pubkey` returns empty | Socket path wrong | Check `NOSTR_SIGNER_SOCKET` in .env and that daemon socket matches |
| `Failed to publish to any relay` | Network / relay outage | Try again; check relay list in `NOSTR_RELAYS` env var |
| `Event ID` prints but note invisible on clients | Propagation delay | Wait 60 seconds; check [relay.nostr.band](https://relay.nostr.band) directly |
| Permission denied on socket | Socket ownership | `sudo chown <your-user> /run/nostr/signer.sock` |
