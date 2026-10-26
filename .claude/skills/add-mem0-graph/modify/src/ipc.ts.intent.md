# Intent: src/ipc.ts

## What changed
Added memory/ IPC directory processing alongside existing messages/ and tasks/ directories. Memory operations from containers are processed and forwarded to the mem0 bridge.

## Key sections
- **Imports**: Added mem0-memory imports (searchMemories, addMemory, updateMemory, removeMemory, forgetSession, forgetTimerange, getMemoryHistory)
- **processIpcFiles()**: Added memory directory scanning after tasks directory
- **New function processMemoryIpc()**: Handles memory_add, memory_update, memory_remove, memory_search (request-response), memory_forget_session, memory_forget_timerange, memory_history

## Invariants
- All existing IPC processing unchanged (messages, tasks)
- processTaskIpc function completely unchanged
- IpcDeps interface unchanged
- Authorization model unchanged (main can access all, others only own group)
- Error handling pattern unchanged (move failed files to errors/)

## Must-keep
- The entire processTaskIpc function
- All existing message handling (type: 'message', type: 'reaction')
- The recovery interval logic
- The statusHeartbeat call
