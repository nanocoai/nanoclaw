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
pnpm install @chat-adapter/slack@4.29.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
2. Name it (e.g., "NanoClaw") and select your workspace
3. Go to **OAuth & Permissions** and add Bot Token Scopes:
   - `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`, `reactions:write`
4. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-...`)
5. Go to **Basic Information** and copy the **Signing Secret**

### Enable DMs

6. Go to **App Home** and enable the **Messages Tab**
7. Check **"Allow users to send Slash commands and messages from the messages tab"**

### Event Subscriptions

8. Go to **Event Subscriptions** and toggle **Enable Events**
9. **Webhook mode:** set the **Request URL** to `https://your-domain/webhook/slack` — Slack will send a verification challenge; it must pass before you can save. For **Socket Mode** (below), skip the Request URL.
10. Under **Subscribe to bot events**, add:
    - `message.channels`, `message.groups`, `message.im`, `app_mention`
11. Click **Save Changes**
12. Slack will show a banner asking you to **reinstall the app** — click it to apply the new event subscriptions

### Socket Mode (optional — no public URL)

Socket Mode delivers events over an outbound WebSocket the bot opens to Slack, so the host needs **no public HTTPS endpoint** — ideal for local dev or a host behind NAT/a firewall. Setting `SLACK_APP_TOKEN` is what flips the adapter into Socket Mode; without it the adapter stays in webhook mode.

13. Go to **Basic Information** > **App-Level Tokens** > **Generate Token and Scopes**, add the `connections:write` scope, and copy the token (`xapp-...`)
14. Go to **Socket Mode** and toggle **Enable Socket Mode** on
15. Keep **Event Subscriptions** enabled with the bot events above — under Socket Mode no Request URL is required

### Configure environment

Add to `.env` — **webhook mode**:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
```

…or **Socket Mode** (no public URL; signing secret optional):

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Webhook server (webhook mode only)

In **webhook mode** the Chat SDK bridge automatically starts a shared webhook server on port 3000 (configurable via `WEBHOOK_PORT` env var). The server handles `/webhook/slack` for Slack and other webhook-based adapters. This port must be publicly reachable from the internet for Slack to deliver events. **In Socket Mode this is not needed** — skip this section if you set `SLACK_APP_TOKEN`.

If running locally, discuss options for exposing the server — e.g. ngrok (`ngrok http 3000`), Cloudflare Tunnel, or a reverse proxy on a VPS. The resulting public URL becomes the base for `https://your-domain/webhook/slack`.

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
