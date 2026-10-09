# Intent: src/index.ts modifications

## What changed
Refactored from single WhatsApp channel to multi-channel architecture using the `Channel` interface, adding Nostr support.

## Key sections

### Imports (top of file)
- Added: `NostrChannel` from `./channels/nostr.js`
- Added: `NOSTR_ONLY`, `NOSTR_PRIVATE_KEY`, `NOSTR_USER_PUBKEY`, `NOSTR_RELAYS` from `./config.js`
- Added: `findChannel` from `./router.js`
- Added: `Channel` type from `./types.js`

### Module-level state
- Added: `const channels: Channel[] = []` — array of all active channels
- Kept: `let whatsapp: WhatsAppChannel` — still needed for `syncGroupMetadata` reference

### processGroupMessages()
- Added: `findChannel(channels, chatJid)` lookup at the start
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` (optional chaining)
- Changed: `whatsapp.sendMessage()` → `channel.sendMessage()` in output callback

### startMessageLoop()
- Added: `findChannel(channels, chatJid)` lookup per group in message processing
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` for typing indicators

### main()
- Changed: shutdown disconnects all channels via `for (const ch of channels)`
- Added: shared `channelOpts` object for channel callbacks
- Added: conditional WhatsApp creation (`if (!NOSTR_ONLY)`)
- Added: conditional Nostr creation (`if (NOSTR_PRIVATE_KEY)`)
- Changed: scheduler `sendMessage` uses `findChannel()` → `channel.sendMessage()`
- Changed: IPC `sendMessage` uses `findChannel()` → `channel.sendMessage()`

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
