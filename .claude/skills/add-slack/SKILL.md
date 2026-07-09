---
name: add-slack
description: Add Slack channel integration via Chat SDK. Uses Socket Mode — no public URL or webhook endpoint required.
---

# Add Slack Channel

Adds Slack support via the Chat SDK bridge in Socket Mode. The bot connects outbound to Slack over WebSocket, so no public URL or reverse proxy is needed — works on a laptop, behind a firewall, etc.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Slack adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/slack.ts` exists
- `src/channels/slack-registration.test.ts` exists
- `src/channels/index.ts` contains `import './slack.js';`
- `@chat-adapter/slack` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and its registration test

```bash
git show origin/channels:src/channels/slack.ts                 > src/channels/slack.ts
git show origin/channels:src/channels/slack-registration.test.ts > src/channels/slack-registration.test.ts
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

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/slack-registration.test.ts
```

Both must be clean before proceeding. `slack-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `slack`. It goes red if the `import './slack.js';` line is deleted or drifts, if the barrel fails to evaluate, or if `@chat-adapter/slack` isn't installed (the import throws) — so it also implicitly verifies the dependency from step 4. The adapter also calls core's `createChatSdkBridge(...)`; that typed core-API consumption is guarded by `pnpm run build`.

End-to-end message delivery against a real Slack workspace is verified manually once the service is running — see Next Steps and the webhook setup above.

## Credentials

### Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**
2. Name it (e.g., "NanoClaw") and select your workspace

### Enable Socket Mode

3. Go to **Socket Mode** in the left sidebar and toggle **Enable Socket Mode** ON
4. Slack will prompt you to create an **App-Level Token**. Name it anything (e.g. `socket`), grant the **`connections:write`** scope, and click **Generate**
5. Copy the token — it starts with `xapp-...`. Save it now; you can't view it again later.

### OAuth scopes

6. Go to **OAuth & Permissions** and under **Scopes** > **Bot Token Scopes**, add:
   - `chat:write`, `im:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`, `reactions:write`, `files:read`, `files:write`

### Subscribe to bot events

7. Go to **Event Subscriptions** and toggle **Enable Events** ON
   - No Request URL is needed — Socket Mode delivers events over the WebSocket connection
8. Under **Subscribe to bot events**, add:
   - `message.channels`, `message.groups`, `message.im`, `app_mention`
9. Click **Save Changes**

### Enable DMs

10. Go to **App Home** and enable the **Messages Tab**
11. Check **"Allow users to send Slash commands and messages from the messages tab"**

### Install to workspace

12. Go to **Install App** and click **Install to Workspace** > **Allow**
13. Copy the **Bot User OAuth Token** — it starts with `xoxb-...`

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-level-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

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
