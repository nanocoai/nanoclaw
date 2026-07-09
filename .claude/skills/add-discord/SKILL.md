---
name: add-discord
description: Add Discord bot channel integration via Chat SDK.
---

# Add Discord Channel

Adds Discord bot support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Discord adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/discord.ts` exists
- `src/channels/discord-registration.test.ts` exists
- `src/channels/index.ts` contains `import './discord.js';`
- `@chat-adapter/discord` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and its registration test

```bash
git show origin/channels:src/channels/discord.ts                 > src/channels/discord.ts
git show origin/channels:src/channels/discord-registration.test.ts > src/channels/discord-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './discord.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/discord@4.29.0
```

### 5. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/discord-registration.test.ts
```

Both must be clean before proceeding. `discord-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `discord`. It goes red if the `import './discord.js';` line is deleted or drifts, if the barrel fails to evaluate, or if `@chat-adapter/discord` isn't installed (the import throws) — so it also implicitly verifies the dependency from step 4. The adapter also calls core's `createChatSdkBridge(...)`; that typed core-API consumption is guarded by `pnpm run build`.

## Credentials

### Create Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name (e.g., "NanoClaw Assistant")
3. From the **General Information** tab, copy the **Application ID** and **Public Key**
4. Go to the **Bot** tab and click **Add Bot** if needed
5. Copy the Bot Token (click **Reset Token** if you need a new one — you can only see it once)
6. Under **Privileged Gateway Intents**, enable **Message Content Intent**
7. Go to **OAuth2** > **URL Generator**:
   - Scopes: select `bot`
   - Bot Permissions: select `Send Messages`, `Read Message History`, `Add Reactions`, `Attach Files`, `Use Slash Commands`
8. Copy the generated URL and open it in your browser to invite the bot to your server

### Configure environment

All three values are required — the adapter will fail to start without `DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID`.

Add to `.env`:

```bash
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=your-application-id
DISCORD_PUBLIC_KEY=your-public-key
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `discord`
- **terminology**: Discord has "servers" (also called "guilds") containing "channels." Text channels start with #. The bot can also receive direct messages.
- **how-to-find-id**: Enable Developer Mode in Discord (Settings > App Settings > Advanced > Developer Mode). Then right-click a server and select "Copy Server ID" for the guild ID, and right-click the text channel and select "Copy Channel ID." The platform ID format used in registration is `discord:{guildId}:{channelId}` — both IDs are required.
- **supports-threads**: yes
- **typical-use**: Interactive chat — server channels or direct messages
- **default-isolation**: Same agent group for your personal server. Separate agent group for servers with different communities or where different members have different information boundaries.
