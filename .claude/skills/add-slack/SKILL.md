---
name: add-slack
description: Add Slack channel integration via Chat SDK.
---

# Add Slack Channel

Adds Slack support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Slack adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/slack.ts` exists
- `src/channels/index.ts` contains `import './slack.js';`
- `@chat-adapter/slack` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/slack.ts > src/channels/slack.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './slack.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/slack@4.27.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

The adapter supports two delivery modes — pick one and follow the matching steps below.

| Mode | When to use | What you need |
|------|-------------|---------------|
| **Socket Mode** (recommended for local installs) | Running NanoClaw on a laptop, NAS, or anywhere without a stable public URL. | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` |
| **Webhook Mode** | Running on a VPS or behind a stable public URL where Slack can POST events. | `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` |

Mode is auto-detected from the env: if `SLACK_APP_TOKEN` is set, the adapter uses Socket Mode; otherwise it falls back to webhook mode.

### Create Slack App (both modes)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
2. Name it (e.g., "NanoClaw") and select your workspace
3. Go to **OAuth & Permissions** and add Bot Token Scopes:
   - `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`, `reactions:write`
4. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`)

### Enable DMs (both modes)

5. Go to **App Home** and enable the **Messages Tab**
6. Check **"Allow users to send Slash commands and messages from the messages tab"**

### Socket Mode setup

7. Go to **Socket Mode** in the left sidebar and toggle **Enable Socket Mode**
8. Slack will prompt you to create an **App-Level Token** — name it (e.g., "socket") and grant the `connections:write` scope. Copy the token (`xapp-...`)
9. Go to **Event Subscriptions**, toggle **Enable Events**, and under **Subscribe to bot events** add:
   - `message.channels`, `message.groups`, `message.im`, `app_mention`
10. Click **Save Changes**
11. Slack will show a banner asking you to **reinstall the app** — click it to apply the new event subscriptions

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

No public URL or port forwarding required — the adapter opens an outbound WebSocket to Slack.

### Webhook Mode setup

7. Go to **Basic Information** and copy the **Signing Secret**
8. Go to **Event Subscriptions** and toggle **Enable Events**
9. Set the **Request URL** to `https://your-domain/webhook/slack` — Slack will send a verification challenge; it must pass before you can save
10. Under **Subscribe to bot events**, add:
    - `message.channels`, `message.groups`, `message.im`, `app_mention`
11. Click **Save Changes**
12. Slack will show a banner asking you to **reinstall the app** — click it to apply the new event subscriptions

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

The Chat SDK bridge automatically starts a shared webhook server on port 3000 (configurable via `WEBHOOK_PORT` env var). The server handles `/webhook/slack` for Slack and other webhook-based adapters. This port must be publicly reachable from the internet for Slack to deliver events.

If running locally, discuss options for exposing the server — e.g. ngrok (`ngrok http 3000`), Cloudflare Tunnel, or a reverse proxy on a VPS. The resulting public URL becomes the base for `https://your-domain/webhook/slack`. (If you don't have a stable public URL, prefer Socket Mode above.)

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `slack`
- **terminology**: Slack has "workspaces" containing "channels." Channels can be public (#general) or private. The bot can also receive direct messages.
- **platform-id-format**: `slack:{channelId}` for channels (e.g., `slack:C0123ABC`), `slack:{dmId}` for DMs (e.g., `slack:D0ARWEBLV63`)
- **how-to-find-id**: Right-click a channel name > "View channel details" — the Channel ID is at the bottom (starts with C). For DMs, the ID starts with D. Or copy the channel link — the ID is the last segment of the URL.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team channels or direct messages
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.
