---
name: add-gpt-live
description: Add the GPT-Live channel — OpenAI's full-duplex voice model (gpt-live-1) as the mouth and ears of a browser or phone call, with the NanoClaw agent as the brain. Native adapter, client-delegation mode, no Chat SDK bridge. Use when the user wants to talk to an agent by voice, give an agent a phone presence, or try GPT-Live-1 with NanoClaw.
---

# Add GPT-Live Channel

Adds [GPT-Live-1](https://developers.openai.com/api/docs/guides/live) as a
voice channel. The voice model handles listening and speaking in real time;
every turn that needs facts, memory, tools or an action is delegated to a
NanoClaw session, whose reply is spoken back. Native adapter: the host creates
the live session, attaches a server-side sideband WebSocket, and maps
delegations to inbound messages and agent replies to spoken commentary.
NanoClaw doesn't ship channels in trunk — this skill copies the adapter and its
tests in from the `channels` branch.

Two ways to call the agent. **Browser** (this skill): a call page served by the
host; needs only a URL the caller's browser can reach. **Phone** (SIP, a later
step): a SIP trunk pointed at OpenAI plus a public webhook URL.

Costs money: OpenAI bills voice sessions at $0.05 per minute, per second,
plus the agent's own model usage.

## Apply

### 1. Copy the adapter and tests

Fetch the `channels` branch and copy the adapter, its session state machine,
and their tests into place (overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/gpt-live.ts
src/channels/gpt-live-session.ts
src/channels/gpt-live-session.test.ts
src/channels/gpt-live-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if present).
This one line is the skill's only reach-in into the channel core:

```nc:append to:src/channels/index.ts
import './gpt-live.js';
```

### 3. Teach agents to write for the ear

Replies on this channel are spoken. Mount the formatting skill so every agent
answers a call in short plain prose. `container/skills/` is mounted read-only
into every agent container; the skill only changes behaviour when a message
arrives from the `gpt-live` channel:

```nc:copy
container-skills/gpt-live-formatting/SKILL.md -> container/skills/gpt-live-formatting/SKILL.md
```

### 4. Build

No new package: the adapter uses Node's built-in `fetch` and WebSocket client
(Node 22 or later, which NanoClaw already requires). Build first: it guards the
adapter's typed calls into the channel core.

```nc:run effect:build
pnpm run build
```

### 5. Validate

Run the registration test and the session state-machine tests:

```nc:run effect:test
pnpm exec vitest run src/channels/gpt-live-registration.test.ts src/channels/gpt-live-session.test.ts
```

`gpt-live-registration.test.ts` imports the real channel barrel and asserts the
registry contains `gpt-live` — it goes red if the import line drifts.
`gpt-live-session.test.ts` covers the delegation bookkeeping (transcript cut,
chunking, barge-in). A real call is verified manually once the service runs.

## Connect to OpenAI

### API key

The adapter needs an OpenAI API key with access to `gpt-live-1`. It is read from
`.env` on the host; the agent container never sees it.

```nc:prompt openai_api_key secret validate:^sk-.{20,}$ normalize:trim
Paste an OpenAI API key with access to gpt-live-1 (starts with sk-). Create one at https://platform.openai.com/api-keys
```
```nc:env-set
OPENAI_API_KEY={{openai_api_key}}
```

### Public URL

The call page and the SDP handshake are served by the host's webhook server.
Give the origin a caller's browser reaches it at — `http://localhost:3000` for
a local try, a tailnet or tunnel URL to call from a phone's browser. Set-if-absent,
so a re-run keeps your value:

```nc:prompt public_url validate:^https?://\S+$ normalize:rstrip-slash
What origin can a caller's browser reach this NanoClaw host at? (e.g. http://localhost:3000 or https://nanoclaw.example.ts.net)
```
```nc:env-set
GPT_LIVE_PUBLIC_URL={{public_url}}
GPT_LIVE_VOICE=marin
```

## Restart and wire

Restart the service so the adapter registers its routes:

```nc:run effect:restart
bash setup/lib/restart.sh
```

Then wire the channel to an agent group the same way as any other channel —
run `/manage-channels` and pick `gpt-live`. Unknown callers are declined
politely and the owner gets a one-line FYI; grant access with `ncl members add`.

Tell the user where to call from:

```nc:operator
The call page is at {{public_url}}/webhook/gpt-live/call. Open it in a browser, allow the microphone, and say hello. Ask something that needs memory ("what did we decide about the launch date?") to see the agent get involved.
```

## Done

Callers talk to the voice model; anything needing the agent is handed over and
the answer is spoken back. Session ids are logged in `logs/nanoclaw.log`; quote
one if you need OpenAI's help with a call.

Phone calls over SIP are the next step: an inbound trunk pointed at
`sip:<PROJECT_ID>@sip.api.openai.com;transport=tls` and a public webhook URL.
To uninstall: see [REMOVE.md](REMOVE.md).

## Troubleshooting

**The call page loads but nothing happens after allowing the microphone.**
Check `logs/nanoclaw.error.log` for `gpt-live: session create failed`. A `401`
means the key in `.env` is wrong or lacks `gpt-live-1` access; a `429` means the
project's concurrent-session limit is reached.

**The agent never gets involved.** The voice model delegates only when its
instructions tell it to. Ask something it cannot know (your calendar, a past
decision). If it still answers alone, the delegation event is not reaching the
host: look for `gpt-live: sideband` lines in `logs/nanoclaw.error.log`.

**The caller hears the answer twice.** The agent repeated the voice model's own
words. The transcript marks them as `Assistant:` lines; the formatting skill
tells the agent not to echo them — check it is present under
`container/skills/gpt-live-formatting/`.

**`gpt-live` is missing from `ncl` channel lists.** The factory returned null
because `OPENAI_API_KEY` is absent from `.env`. Set it and restart.
