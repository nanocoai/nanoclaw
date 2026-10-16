# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed
Extended the `send_message` MCP tool to accept an optional `image_path` parameter, allowing agents to send images (e.g. browser screenshots) to users.

## Key sections

### send_message tool schema
- Added: `image_path` optional parameter (z.string().optional()) between `text` and `sender`
- Describes accepted formats: jpeg, png, webp, gif

### send_message tool handler
- Added: early-return branch at the top of the handler when `args.image_path` is provided
- Reads the file, base64-encodes it, infers MIME type from extension
- Writes an IPC file with `type: 'image'`, `imageBase64`, `mimeType`, and optional `caption` (from `args.text`)
- Returns early — does NOT also write a text message

## Invariants (must-keep)
- When `image_path` is absent, the handler is completely unchanged (existing text message path)
- All other tools unchanged: schedule_task, list_tasks, pause_task, resume_task, cancel_task, register_group
- writeIpcFile helper unchanged
- Environment variable context (chatJid, groupFolder, isMain) unchanged
