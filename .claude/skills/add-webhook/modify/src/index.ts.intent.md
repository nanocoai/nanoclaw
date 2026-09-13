# Intent: src/index.ts modifications

## What changed
Added Webhook as a channel option alongside WhatsApp, extending the existing multi-channel architecture.

## Key sections

### Imports (top of file)
- Added: `WebhookChannel` from `./channels/webhook.js`
- Added: `WEBHOOK_PORT`, `WEBHOOK_HOST`, `WEBHOOK_TOKEN`, `WEBHOOK_CONNECTOR_URL`, `WEBHOOK_ONLY` from `./config.js`

### main()
- Changed: WhatsApp channel creation wrapped in `if (!WEBHOOK_ONLY)`
- Added: conditional Webhook creation (`if (WEBHOOK_PORT)`) and connect flow
- Added: webhook channel appended to `channels` array

### Multi-channel routing
- Unchanged: `findChannel(channels, jid)` based routing for scheduler, IPC, and message loop
- Unchanged: shutdown iterates the `channels` array and disconnects all active channels

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in `processGroupMessages`
