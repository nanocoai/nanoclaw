# Intent: container/agent-runner/src/ipc-mcp-stdio.ts

## What changed
Added 7 memory MCP tools that agents can use to explicitly save, search, update, remove, and forget memories. These tools write IPC files that the host processes.

## Key sections
- **Constants**: Added MEMORY_DIR path constant
- **New tools**: memory_save, memory_search, memory_update, memory_remove, memory_forget_session, memory_forget_timerange, memory_history
- **memory_search**: Uses request-response pattern (write request, poll for response file)

## Invariants
- All existing tools unchanged (send_message, react_to_message, schedule_task, list_tasks, pause_task, resume_task, cancel_task, update_task, register_group)
- McpServer configuration unchanged
- writeIpcFile helper unchanged
- Transport and server startup unchanged

## Must-keep
- All existing tool definitions
- writeIpcFile function
- Environment variable reading (chatJid, groupFolder, isMain)
- StdioServerTransport connection at the end
