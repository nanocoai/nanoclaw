# Intent: src/routing.test.ts modifications

## What changed
Added two new test cases for Nostr JID handling in the routing layer.

## Key sections
- **JID ownership patterns**: Added test confirming `nostr:<hex-pubkey>` JIDs start with `nostr:` prefix. This validates the pattern that `NostrChannel.ownsJid()` uses.
- **getAvailableGroups**: Added test confirming Nostr DMs (stored with `isGroup=false`) are excluded from the group list. Nostr DMs are 1:1 conversations, not groups.

## Invariants
- All existing routing tests remain unchanged
- New tests are appended within the existing `describe` blocks
- No existing test behavior or assertions are modified
- The `storeChatMetadata` calls use `'nostr'` as the channel parameter and `false` for `isGroup`

## Must-keep
- All existing JID ownership pattern tests (WhatsApp group `@g.us`, WhatsApp DM `@s.whatsapp.net`)
- All existing `getAvailableGroups` tests (group filtering, sentinel exclusion, registration marking, ordering, empty array)
- The `beforeEach` setup with `_initTestDatabase()` and `_setRegisteredGroups({})`
