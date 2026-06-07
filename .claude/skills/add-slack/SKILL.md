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
- `patches/@chat-adapter__slack@4.27.0.patch` exists and is registered under `patchedDependencies` in `pnpm-workspace.yaml`

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

### 4. Install the adapter package (pinned, with the Slack 3000-char fix)

Vercel's Chat SDK (`@chat-adapter/slack`) builds Slack `section` blocks with no
length cap. Slack rejects the **entire** message if any section's text exceeds
3000 chars (`invalid_blocks`), so long agent replies are silently dropped. The
bug is unfixed upstream through at least 4.30.0, so we carry a pnpm patch that
splits oversized `section`/`context` blocks at newline/word boundaries, caps
`header` text at 150 chars, and guards Slack's 50-block-per-message limit.

Copy the patch in:

```bash
mkdir -p patches
git show origin/channels:patches/@chat-adapter__slack@4.27.0.patch > 'patches/@chat-adapter__slack@4.27.0.patch'
```

Register it under `patchedDependencies` in `pnpm-workspace.yaml` (create the key if it doesn't exist):

```yaml
patchedDependencies:
  '@chat-adapter/slack@4.27.0': patches/@chat-adapter__slack@4.27.0.patch
```

Then install — pnpm applies the patch during install:

```bash
pnpm install @chat-adapter/slack@4.27.0
```

> **Maintenance:** the patch is version-locked to `4.27.0`. If you bump the
> package, regenerate it (`pnpm patch @chat-adapter/slack@<new>`, re-add the
> `splitOversizedSectionBlocks` post-processor in `cardToBlockKit`) or drop it
> once the fix lands upstream in [vercel/chat](https://github.com/vercel/chat).

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
9. Set the **Request URL** to `https://your-domain/webhook/slack` — Slack will send a verification challenge; it must pass before you can save
10. Under **Subscribe to bot events**, add:
    - `message.channels`, `message.groups`, `message.im`, `app_mention`
11. Click **Save Changes**
12. Slack will show a banner asking you to **reinstall the app** — click it to apply the new event subscriptions

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Webhook server

The Chat SDK bridge automatically starts a shared webhook server on port 3000 (configurable via `WEBHOOK_PORT` env var). The server handles `/webhook/slack` for Slack and other webhook-based adapters. This port must be publicly reachable from the internet for Slack to deliver events.

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
