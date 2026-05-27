# 01 — Telegram channel

## Problem we solved in v1

Need Telegram as the only chat surface for the assistant. Bot replies to `@Andy` mentions, downloads incoming files, threads/topics, reply context.

## What we did in v1 (do NOT carry over)

- Merged `qwibitai/nanoclaw-telegram` fork as remote `telegram`
- Local `src/channels/telegram.ts` (440 LOC) using `grammy` directly
- Hardcoded `parse_mode: 'Markdown'` in two places
- File download via `bot.api.getFile` + `fetch` to `groups/<folder>/attachments/`
- DB columns `reply_to_message_id`, `reply_to_message_content`, `reply_to_sender_name`
- `package.json` += `grammy: ^1.39.3`

## v2 idiomatic solution

Apply skill **`/add-telegram`** from upstream. v2 uses `@chat-adapter/telegram` (Chat SDK family) instead of `grammy`. Channel adapters live on the `channels` branch — installed by the skill (`git show origin/channels:src/channels/telegram.ts > src/channels/telegram.ts` etc.) plus `setup/pair-telegram.ts` registration. Pairing is self-contained (chat ownership verification, `getChat` for channel name resolution, max-text-length splitter).

## Things v2 already covers (no carry-over needed)

| v1 concern | v2 solution |
|---|---|
| File attachments | Built into adapter |
| Reply context | v2 has `reply_to_*` in session DB |
| Threads/topics | `message_thread_id` in adapter |
| Message splitting (4096) | `engage splitter` wired via `maxTextLength` |
| Channel name resolution | `resolveChannelName` via `getChat` API |
| Markdown sanitizer (legacy parse_mode) | `telegram-markdown-sanitize.ts` — but see [03-formatting.md](03-formatting.md), we may bypass this entirely |

## How to apply (Stage 2.5)

1. Ensure `data/v2.db` exists and channel auth secret is in `.env`:
   ```
   TELEGRAM_BOT_TOKEN=...
   ```
2. Activate skill: `/add-telegram`
3. Skill will: fetch `origin/channels`, copy adapter files, register in `setup/index.ts` STEPS map, install `@chat-adapter/telegram@4.26.0`, build.
4. Pair the bot: `pnpm run setup` → step `pair-telegram` → BotFather token paste → pairing message in Telegram.
5. The paired chat (`tg:42582289`, "Main") will be registered as a `messaging_group`. Wire it to the agent group in Stage 3.

## Telegram-specific notes

- BotFather privacy mode must be **disabled** (so bot sees non-mention group messages too) — was already configured on the v1 server, no change needed.
- The current bot username / token from the v1 server is reusable. No need to re-create the bot.
