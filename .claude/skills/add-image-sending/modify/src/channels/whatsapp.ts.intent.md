# Intent: src/channels/whatsapp.ts modifications

## What changed
Added `sendImage` method to `WhatsAppChannel` so agents can send images (e.g. browser screenshots) to users via WhatsApp.

## Key sections

### New method: sendImage
- Added after `sendMessage`, before `isConnected`
- Sends image buffer via Baileys `sendMessage({ image: buffer, caption })`
- Applies the same name prefix logic as `sendMessage` (skipped when `ASSISTANT_HAS_OWN_NUMBER`, applied otherwise)
- Logs a warning and returns early if disconnected (no queue — images are not queued for retry)
- Logs error on send failure

## Invariants (must-keep)
- All existing methods unchanged: connect, connectInternal, sendMessage, isConnected, ownsJid, disconnect, setTyping, syncGroupMetadata, translateJid, flushOutgoingQueue
- All imports unchanged
- Outgoing queue logic (for text messages) unchanged
- Reconnection logic unchanged
