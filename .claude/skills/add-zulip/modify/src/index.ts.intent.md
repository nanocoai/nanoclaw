# Intent: src/index.ts modifications

## What changed
Added Zulip as a channel option alongside WhatsApp, using the existing multi-channel infrastructure.

## Key sections

### Imports (top of file)
- Added: `ZulipChannel` from `./channels/zulip.js`
- Added: `ZULIP_SITE`, `ZULIP_BOT_EMAIL`, `ZULIP_BOT_API_KEY`, `ZULIP_ONLY` from `./config.js`

### main() — channel creation block
- Changed: WhatsApp creation is guarded with `if (!ZULIP_ONLY)` — same pattern as DISCORD_ONLY / TELEGRAM_ONLY
- Added: conditional Zulip creation `if (ZULIP_BOT_EMAIL && ZULIP_SITE && ZULIP_BOT_API_KEY)` — requires all three credentials

## Invariants
- All existing message-processing logic (triggers, cursors, idle timers) is unchanged.
- The `runAgent` function is unchanged.
- State management (loadState/saveState) is unchanged.
- Recovery logic is unchanged.
- Container runtime check is unchanged.
- The `channels[]` array and `findChannel()` usage are already in the base.

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The `whatsapp?.syncGroupMetadata` fallback in startIpcWatcher

## Merge conflict guidance
When this skill is applied alongside `discord` or `telegram`, a three-way merge
conflict is expected in the channel-creation block of `main()` because all three
skills change the same region (the WhatsApp connection block).

**Correct resolved state** — all three channels (Discord + Telegram + Zulip example):

```typescript
  if (!DISCORD_ONLY && !TELEGRAM_ONLY && !ZULIP_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (DISCORD_BOT_TOKEN) {
    const discord = new DiscordChannel(DISCORD_BOT_TOKEN, channelOpts);
    channels.push(discord);
    await discord.connect();
  }

  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
    channels.push(telegram);
    await telegram.connect();
  }

  if (ZULIP_BOT_EMAIL && ZULIP_SITE && ZULIP_BOT_API_KEY) {
    const zulipChannel = new ZulipChannel(ZULIP_SITE, ZULIP_BOT_EMAIL, ZULIP_BOT_API_KEY, channelOpts);
    channels.push(zulipChannel);
    await zulipChannel.connect();
  }
```

Adjust the `!DISCORD_ONLY && !TELEGRAM_ONLY && !ZULIP_ONLY` guard to include
only the `_ONLY` flags for the channel skills you have actually applied.
The imports at the top of the file also need each channel's `*_ONLY` and
`*_BOT_TOKEN`/credential variables added.
