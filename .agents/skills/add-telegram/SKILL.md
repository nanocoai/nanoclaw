---
name: add-telegram
description: Add Telegram channel integration via Chat SDK.
---

# Add Telegram Channel

Adds Telegram bot support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Telegram adapter, its formatting/pairing helpers, their tests, and the `pair-telegram` setup step in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/telegram.ts`, `telegram-pairing.ts`, `telegram-markdown-sanitize.ts` (and their `.test.ts` siblings) all exist
- `src/channels/index.ts` contains `import './telegram.js';`
- `setup/pair-telegram.ts` exists and `setup/index.ts`'s `STEPS` map contains `'pair-telegram':`
- `@chat-adapter/telegram` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter, helpers, tests, and setup step

```bash
git show origin/channels:src/channels/telegram.ts                        > src/channels/telegram.ts
git show origin/channels:src/channels/telegram-pairing.ts                > src/channels/telegram-pairing.ts
git show origin/channels:src/channels/telegram-pairing.test.ts           > src/channels/telegram-pairing.test.ts
git show origin/channels:src/channels/telegram-markdown-sanitize.ts      > src/channels/telegram-markdown-sanitize.ts
git show origin/channels:src/channels/telegram-markdown-sanitize.test.ts > src/channels/telegram-markdown-sanitize.test.ts
git show origin/channels:setup/pair-telegram.ts                          > setup/pair-telegram.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './telegram.js';
```

### 4. Register the setup step

In `setup/index.ts`, add this entry to the `STEPS` map (right after the `register` line is fine; skip if already present):

```typescript
'pair-telegram': () => import('./pair-telegram.js'),
```

### 5. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/telegram@4.27.0
```

### 6. Build

```bash
pnpm run build
```

## Credentials

### Create Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts:
   - Bot name: Something friendly (e.g., "NanoClaw Assistant")
   - Bot username: Must end with "bot" (e.g., "nanoclaw_bot")
3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

**Important for group chats**: By default, Telegram bots only see @mentions and commands in groups. To let the bot see all messages:

1. Open `@BotFather` > `/mybots` > select your bot
2. **Bot Settings** > **Group Privacy** > **Turn off**

### Configure environment

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `telegram`
- **terminology**: Telegram calls them "groups" and "chats." A "group" has multiple members; a "chat" is a 1:1 conversation with the bot.
- **how-to-find-id**: Do NOT ask the user for a chat ID. Telegram registration uses pairing — run `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent <main|wire-to:folder|new-agent:folder>`, show the user the 4-digit `CODE` from the `PAIR_TELEGRAM_ISSUED` block (follow the `REMINDER_TO_ASSISTANT` line in that block), and tell them to send just the 4 digits as a message from the chat they want to register (DM the bot for `main`, post in the group otherwise). In groups with Group Privacy ON, prefix with the bot handle: `@<botname> CODE`. Wrong guesses invalidate the code — if a `PAIR_TELEGRAM_ATTEMPT` block arrives with a mismatched `RECEIVED_CODE`, a `PAIR_TELEGRAM_NEW_CODE` block will follow automatically (up to 5 regenerations); show the new code. On `PAIR_TELEGRAM STATUS=failed ERROR=max-regenerations-exceeded`, ask the user if they want to try again and re-invoke the step — each invocation starts a fresh 5-attempt batch. Success emits `PAIR_TELEGRAM STATUS=success` with `PLATFORM_ID`, `IS_GROUP`, and `ADMIN_USER_ID`. The service must be running for this to work (the polling adapter is what observes the code).
- **supports-threads**: no
- **typical-use**: Interactive chat — direct messages or small groups
- **default-isolation**: Same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.
