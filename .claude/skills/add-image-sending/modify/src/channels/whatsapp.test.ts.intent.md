# Intent: src/channels/whatsapp.test.ts modifications

## What changed
Added a new `describe('sendImage')` block with 3 test cases for the new `sendImage` method.

## Key sections

### New describe block: 'sendImage'
Added at the end of the outer `describe('WhatsAppChannel')` block, after `describe('channel properties')`:
- "sends image with prefixed caption on shared number" — verifies `sock.sendMessage` called with `{ image: buf, caption: 'Andy: look at this' }` (ASSISTANT_HAS_OWN_NUMBER is false in test mock)
- "sends image without caption" — verifies `sock.sendMessage` called with `{ image: buf, caption: undefined }`
- "drops image silently when disconnected" — verifies `sock.sendMessage` not called when channel is not connected

## Invariants (must-keep)
- All existing test describe blocks unchanged: version fetch, connection lifecycle, authentication, reconnection, message handling, LID to JID translation, outgoing message queue, group metadata sync, ownsJid, setTyping, channel properties
- All existing mocks (config, logger, db, fs, child_process, baileys) unchanged
- Test helpers (createTestOpts, triggerConnection, triggerDisconnect, triggerMessages, connectChannel) unchanged
