# Intent: src/index.ts modifications

## What changed
Wired `sendImage` into the `startIpcWatcher` deps so IPC image messages are routed to the appropriate channel.

## Key sections

### startIpcWatcher call
- Added: `sendImage` dep after `sendMessage` in the deps object
- Finds the channel for the JID using existing `findChannel` helper
- Checks `channel.sendImage` exists before calling (channels without image support are skipped with a warning)
- Returns `Promise.resolve()` if channel doesn't support images (graceful no-op)

## Invariants (must-keep)
- `sendMessage` dep unchanged
- All other deps unchanged: registeredGroups, registerGroup, syncGroupMetadata, getAvailableGroups, writeGroupsSnapshot
- Everything else in index.ts unchanged (message loop, container runner setup, queue, session management)
