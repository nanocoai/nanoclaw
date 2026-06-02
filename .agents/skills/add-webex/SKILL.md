---
name: add-webex
description: Add Webex channel integration via Chat SDK.
---

# Add Webex Channel

Adds Cisco Webex support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Webex adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/webex.ts` exists
- `src/channels/index.ts` contains `import './webex.js';`
- `@bitbasti/chat-adapter-webex` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/webex.ts > src/channels/webex.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './webex.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @bitbasti/chat-adapter-webex@0.1.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

1. Go to [developer.webex.com](https://developer.webex.com/my-apps/new/bot) and create a new bot
2. Copy the **Bot Access Token**
3. Set up a webhook:
   - Use the Webex API or Developer Portal to create a webhook pointing to `https://your-domain/webhook/webex`
   - Set a webhook secret for signature verification

### Configure environment

Add to `.env`:

```bash
WEBEX_BOT_TOKEN=your-bot-token
WEBEX_WEBHOOK_SECRET=your-webhook-secret
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `webex`
- **terminology**: Webex has "spaces." A space can be a group conversation or a 1:1 direct message with the bot.
- **how-to-find-id**: Open the space in Webex, click the space name > Settings — the Space ID is listed there. Or use the Webex API (`GET /rooms`) to list spaces and their IDs.
- **supports-threads**: yes
- **typical-use**: Interactive chat — team spaces or direct messages
- **default-isolation**: Same agent group for spaces where you're the primary user. Separate agent group for spaces with different teams or sensitive information.
