# Intent: src/types.ts modifications

## What changed
Added optional `sendImage` method to the `Channel` interface so channels that support image sending can implement it. Channels that don't support images (e.g. Telegram without media config) simply omit it and callers degrade gracefully.

## Key sections

### Channel interface
- Added: `sendImage?(jid: string, buffer: Buffer, caption?: string): Promise<void>` — optional method after `sendMessage`

## Invariants (must-keep)
- All other interface definitions unchanged (AdditionalMount, MountAllowlist, RegisteredGroup, NewMessage, ScheduledTask, TaskRunLog, OnInboundMessage, OnChatMetadata)
- `sendMessage` remains required (not optional)
- `setTyping` optional pattern unchanged
