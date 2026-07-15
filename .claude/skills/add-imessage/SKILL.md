---
name: add-imessage
description: Add iMessage channel integration via Chat SDK. Local (macOS) or remote (Photon API) mode.
---

# Add iMessage Channel

Adds iMessage support via the Chat SDK bridge. Two modes: local (macOS with Full
Disk Access) or remote (Photon API). NanoClaw doesn't ship channels in trunk —
this skill copies the iMessage adapter in from the `channels` branch.

The mechanical steps under **Apply** carry `nc:` directive fences: an agent reads
the prose and applies them, and a parser can apply them deterministically from
the same document. Every directive is idempotent, so the whole skill is safe to
re-run; anything a parser can't apply falls back to the prose beside it.

## Apply

### 1. Copy the adapter

Fetch the `channels` branch and copy the iMessage adapter into `src/channels/`
(overwrite — the branch is canonical):

```nc:copy from-branch:channels
src/channels/imessage.ts
src/channels/imessage-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel (skipped if the line
is already present). This one line is the skill's only reach-in into core:

```nc:append to:src/channels/index.ts
import './imessage.js';
```

### 3. Install the adapter package

Pinned to an exact version — the supply-chain policy rejects ranges and `latest`:

```nc:dep
chat-adapter-imessage@0.1.1
```

### 4. Build and validate

Build guards the typed `createChatSdkBridge(...)` core call and proves the
dependency is installed (the adapter's top-level `import` from
`chat-adapter-imessage` throws if it isn't):

```nc:run effect:build
pnpm run build
```
```nc:run effect:test
pnpm exec vitest run src/channels/imessage-registration.test.ts
```

`imessage-registration.test.ts` imports the real channel barrel and asserts the
registry contains `imessage` — it goes red if the import line is deleted or
drifts, if the barrel fails to evaluate, or if `chat-adapter-imessage` isn't
installed (the import throws), so it also covers the dependency from step 3.

End-to-end message delivery against a real iMessage account is verified manually
once the service is running — see Next Steps.

## Credentials

iMessage runs in one of two modes:

- **Local (macOS)** — the bot runs on this Mac and talks via the signed-in
  iMessage account. Reading `chat.db` needs Full Disk Access granted to the
  Node binary the host runs under.
- **Remote (Photon API)** — the bot talks to a separate Photon server that owns
  an iMessage account on another Mac. Use this off macOS, or to keep this Mac's
  chat history out of the loop.

Mode choice and the Full Disk Access / Photon walkthroughs are human and
interactive. Pick the mode first (local is the macOS default; remote is the only
option off macOS), then walk only that mode's setup — the other mode's steps are
skipped:

```nc:prompt mode validate:^(local|remote)$
How should iMessage run — `local` (this Mac, needs Full Disk Access) or `remote` (a Photon server)?
```

### Local Mode (macOS)

Requirements: macOS, with Full Disk Access granted to the Node binary. Without
it the adapter can't read `chat.db` and inbound messages never arrive.

Local mode only works on a Mac — it reads this machine's iMessage `chat.db`
directly, and there is no such database off macOS. On any other OS, stop here and
use remote (Photon) mode instead; otherwise you'd write a local config that can
never receive a message:

```nc:run effect:check when:mode=local
[ "$(uname)" = Darwin ]
```

The Node binary path is buried deep (e.g. `~/.nvm/versions/node/v22.x.x/bin/node`),
so open its folder in Finder to make the drag-and-drop target obvious. Harmless
off a desktop (SSH/headless) — it just no-ops:

```nc:run effect:external when:mode=local
open "$(dirname "$(which node)")" 2>/dev/null || true
```

Then tell the user:

```nc:operator when:mode=local
Grant Full Disk Access to Node so iMessage can read your chat history:
1. Open System Settings > Privacy & Security > Full Disk Access.
2. Click +, then drag the "node" file from the Finder window that just opened.
3. Toggle it on, then come back here.
```

Stop and wait for the user to confirm Full Disk Access is granted before
continuing.

### Remote Mode (Photon API)

Photon is a separate service that owns an iMessage account and exposes it over
HTTP; NanoClaw talks to it via its API. Tell the user:

```nc:operator when:mode=remote
Set up remote iMessage via Photon:
1. Create a Photon server: https://photon.codes
2. Copy the server URL and API key from your Photon dashboard.
```

Then collect the two values:

```nc:prompt server_url when:mode=remote validate:^https?:// flags:i reuse:IMESSAGE_SERVER_URL
Your Photon server URL — starts with http:// or https:// (e.g. https://photon.example.com).
```
```nc:prompt api_key secret when:mode=remote reuse:IMESSAGE_API_KEY
Your Photon API key — from the Photon dashboard.
```

### Configure environment

The two modes use different `.env` keys. Write only the keys for the chosen
mode, and strip the opposite mode's keys so a stale value can't confuse the
adapter's factory. The configure script owns this upsert-and-remove (a plain
set-if-absent env write can neither replace a stale value nor delete a key):

**Local mode** — writes `IMESSAGE_LOCAL=true` and `IMESSAGE_ENABLED=true`, and
removes `IMESSAGE_SERVER_URL` / `IMESSAGE_API_KEY` if present:

```nc:run effect:external when:mode=local
bash setup/channels/imessage-configure.sh local
```

**Remote mode** — writes `IMESSAGE_LOCAL=false`, `IMESSAGE_SERVER_URL`, and
`IMESSAGE_API_KEY`, and removes `IMESSAGE_ENABLED` if present:

```nc:run effect:external when:mode=remote
bash setup/channels/imessage-configure.sh remote "{{server_url}}" "{{api_key}}"
```

## Restart

Restart the service so it loads the iMessage adapter and the credentials you
just stored, and wait for its CLI socket before wiring:

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Resolve your iMessage handle

The agent greets you in the iMessage conversation tied to the phone number or
Apple ID email you message from — that handle is both your identity and the
conversation address. Resolve it so the owner-wiring step can target it.

```nc:prompt owner_handle validate:^(\+\d{8,15}|[^\s@]+@[^\s@]+\.[^\s@]+)$
The phone number or email you iMessage from — a +E.164 number (e.g. +14155551234) or an email / Apple ID (e.g. you@icloud.com).
```

iMessage is a native adapter: it sends the raw handle as the conversation
address, with no channel prefix — so the messaging-group platform id is that
handle as-is.

```nc:run capture:platform_id
echo "{{owner_handle}}"
```

`owner_handle` and `platform_id` are what the owner-wiring step needs. The
welcome iMessage goes out through the adapter once the service is running — in
local mode that needs Full Disk Access granted (above); in remote mode it goes
via your Photon server.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise wire
this channel with `/init-first-agent` (or `/manage-channels`).

## Channel Info

- **type**: `imessage`
- **terminology**: iMessage has "conversations." Each conversation is with a contact identified by phone number or email address. Group chats are also supported.
- **how-to-find-id**: The platform ID is the contact's phone number (e.g. `+15551234567`) or email address. For group chats, the ID is assigned by iMessage internally.
- **supports-threads**: no
- **typical-use**: Interactive 1:1 chat — personal messaging
- **default-isolation**: Same agent group if you're the only person messaging the bot across iMessage and other channels. Separate agent group if different contacts should have information isolation.

## Troubleshooting

**The mode answer is rejected.** It must be exactly `local` or `remote`, lowercase. Local only exists on macOS — it reads this Mac's `chat.db` directly — so on any other OS the platform check stops you and remote (Photon) is the only path.

**Local mode: outgoing works but nothing ever arrives.** Full Disk Access wasn't granted to the *actual* Node binary the service runs under — with nvm the path changes per Node version (`~/.nvm/versions/node/v22.x.x/bin/node`), so an old grant silently stops covering a new binary. Re-open System Settings → Privacy & Security → Full Disk Access, add the binary at `$(which node)`, then restart the service.

**Remote mode: Photon values rejected or unreachable.** The server URL must start with `http://` or `https://` — copy it and the API key from your Photon dashboard at photon.codes. If the adapter starts but sends fail, curl the server URL from this machine to rule out a network path issue.

**Your handle is rejected at the resolve step.** It must be a bare +E.164 number (`+14155551234` — no spaces, dashes, or parentheses) or an email/Apple ID. Use the exact handle you actually send iMessages from — a number-vs-email mismatch means your messages never map to the wired conversation.

**Adapter installed but silent.** Run `pnpm exec vitest run src/channels/imessage-registration.test.ts` — red means the barrel import or the `chat-adapter-imessage` install drifted, so re-run the Apply steps. If green, restart the service (`bash setup/lib/restart.sh`) so it loads the adapter and the mode config, then check `logs/nanoclaw.error.log`.
