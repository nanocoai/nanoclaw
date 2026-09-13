# Intent: src/ipc.ts modifications

## What changed
Added image IPC message handling so agents can send images to users through the IPC pipeline.

## Key sections

### IpcDeps interface
- Added: `sendImage?: (jid: string, buffer: Buffer, caption?: string) => Promise<void>` — optional dep, after `sendMessage`

### processIpcFiles message handler
- Added: `else if (data.type === 'image' && data.chatJid && data.imageBase64)` branch after the `data.type === 'message'` block
- Applies same authorization check as text messages (isMain or matching folder)
- Decodes base64 buffer and calls `deps.sendImage` if available
- Logs warning and drops gracefully if `deps.sendImage` is not provided (channel doesn't support images)
- Blocked attempts are logged as warnings (same as text message auth failures)

## Invariants (must-keep)
- `data.type === 'message'` handling completely unchanged
- All other IPC types (schedule_task, pause_task, resume_task, cancel_task, register_group) unchanged
- IPC watcher startup, polling interval, directory scanning unchanged
- Error handling and error directory logic unchanged
