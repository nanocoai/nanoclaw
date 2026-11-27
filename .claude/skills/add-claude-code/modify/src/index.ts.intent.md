# Intent: src/index.ts modifications

## What changed
Added Claude Code service lifecycle management (start on boot, stop on shutdown).

## Key sections

### Imports (top of file)
- Added: `startClaudeCodeService`, `stopClaudeCodeService` from `./claude-code-service.js`

### shutdown() handler
- Added: `stopClaudeCodeService()` call alongside `stopQmd()`

### main() — end of function
- Added: `startClaudeCodeService().catch(...)` after the QMD startup block
- Pattern mirrors QMD startup: fire-and-forget with error logging (non-blocking)

## Invariants
- All existing message processing logic is preserved (triggers, cursors, idle timers)
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged
- Channel creation and connection logic is unchanged
- QMD startup is unchanged

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
