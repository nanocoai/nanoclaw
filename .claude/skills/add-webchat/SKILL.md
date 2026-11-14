---
name: add-webchat
description: Add a local browser chat as a channel. Serves a self-contained chat page on localhost — persistent GUI conversation with your agent, no bot token, no external service, no phone.
---

# Add Web Chat Channel

Adds a local browser chat via a native HTTP bridge. The daemon serves a single
self-contained page (no assets, no framework) plus a JSON API on
`127.0.0.1:8767`. On Windows/WSL2, localhost forwarding makes it reachable from
a normal Windows browser tab.

## What you can do with this

- **Persistent GUI conversation** — a real chat window: history on screen, Enter to send, replies appear as they arrive (1s poll)
- **No pairing** — unlike Telegram/WhatsApp channels there is no bot to create and no QR to scan
- **Same conversation everywhere** — wired `agent-shared`, the browser continues the same session as the CLI channel

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the webchat adapter
in from the `channels` branch. Native HTTP bridge — no Chat SDK, no adapter
package, Node builtins only.

### Pre-flight (idempotent)

Skip to **Enable** if all of these are already in place:

- `src/channels/webchat.ts` exists
- `src/channels/webchat.test.ts` exists
- `src/channels/webchat-registration.test.ts` exists
- `src/channels/index.ts` contains `import './webchat.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and tests

```bash
git show origin/channels:src/channels/webchat.ts                   > src/channels/webchat.ts
git show origin/channels:src/channels/webchat.test.ts              > src/channels/webchat.test.ts
git show origin/channels:src/channels/webchat-registration.test.ts > src/channels/webchat-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './webchat.js';
```

### 4. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/webchat.test.ts src/channels/webchat-registration.test.ts
```

Both must be clean before proceeding. `webchat-registration.test.ts` is the one
integration test: it imports the real channel barrel and asserts the registry
contains `webchat` — red if the barrel import is deleted or drifts, or if the
barrel fails to evaluate. The adapter uses only Node builtins (`http`), so
there is no npm dependency to guard for this channel.

## Enable

The adapter is gated by `WEBCHAT_ENABLED` so the port isn't opened on hosts
that don't want it. Add to `.env`:

```bash
WEBCHAT_ENABLED=true
WEBCHAT_CHANNEL_PORT=8767     # optional — change only if 8767 is taken
WEBCHAT_AUTH_TOKEN=           # recommended — random string; gates the JSON API
WEBCHAT_PLATFORM_ID=default   # optional — only change for a non-default chat id
```

Generate a token (recommended even on single-user machines — prevents other
local processes from poking the endpoint; the page itself is served without
auth and holds no secrets):

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Restart the host service afterwards.

## Wire the channel

Web chat is a single-user, single-chat channel: one adapter instance = one
messaging group with `platform_id = "default"` (override with
`WEBCHAT_PLATFORM_ID`).

### If this is your first agent group

Run `/init-first-agent` — pick **Web Chat** as the channel and the skill will
create the agent group, wire the channel, and deliver a welcome message to the
browser page.

### Otherwise — wire to an existing agent group

With the host service running (`ncl` connects to it over a Unix socket):

```bash
ncl messaging-groups create --channel-type webchat --platform-id "default" --name "Web Chat"
ncl wirings create --messaging-group-id <mg-id-from-above> --agent-group-id <ag-id> \
  --session-mode agent-shared
```

`agent-shared` puts browser messages in the same session as any other channel
wired to the same agent group — a conversation you started in Telegram
continues in the browser. Use `shared` for an independent browser thread, or a
new agent group for a dedicated web-only agent.

## Verify

Open `http://localhost:<port>/?token=<your token>` in a browser and send a
message. The header shows `connected` when the poll succeeds; the reply
arrives as a chat bubble. First message after idle may take ~30–60s (container
cold start); subsequent replies are seconds.

## Troubleshooting

- **Page loads, replies never arrive** — check the wiring exists
  (`ncl messaging-groups list`) and tail `logs/nanoclaw.log` for
  `Message routed` / `Message delivered` lines with `channelType="webchat"`.
- **`unauthorized` in the header** — the `?token=` query param doesn't match
  `WEBCHAT_AUTH_TOKEN` in `.env`.
- **Port in use** — change `WEBCHAT_CHANNEL_PORT` and restart the service.
