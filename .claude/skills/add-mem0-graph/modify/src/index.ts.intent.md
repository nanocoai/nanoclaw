# Intent: src/index.ts

## What changed
Integrated mem0 memory system: initMemory at startup, retrieveMemoryContext before agent invocation, captureConversation after successful output.

## Key sections
- **Imports**: Added initMemory, retrieveMemoryContext, captureConversation from './mem0-memory.js'
- **main()**: Added `await initMemory()` after initTraceDb()
- **processGroupMessages()**: Added memory context retrieval before agent call, memory capture after success
- **runAgent()**: No changes to runAgent itself

## Invariants
- All existing imports remain
- processGroupMessages logic flow unchanged (trigger check, cursor management, error recovery)
- runAgent function completely unchanged
- startMessageLoop unchanged
- All existing exports remain
- loadState/saveState unchanged

## Must-keep
- The entire runAgent function
- startMessageLoop function
- recoverPendingMessages function
- All cursor management logic (lastAgentTimestamp, cursorBeforePipe)
- StatusTracker integration
- _setRegisteredGroups test helper
