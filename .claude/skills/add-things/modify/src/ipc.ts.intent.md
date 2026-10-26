# Intent: src/ipc.ts modifications

## What changed

Added Things 3 CLI integration to the host-side IPC watcher. The container agent writes request files to `data/ipc/{group}/things-requests/`; the host runs the `things` binary and writes responses to `data/ipc/{group}/things-responses/`.

## Key additions

### New imports
- `spawnSync` from `child_process` — synchronous subprocess execution for `things` CLI
- `readEnvFile` from `./env.js` — reads `THINGS_AUTH_TOKEN` from `.env`

### New constant
```typescript
const THINGS_BIN = process.env.THINGS_BIN || '/opt/homebrew/bin/things';
```
Overridable via environment variable for Intel Macs (`/usr/local/bin/things`) or custom paths.

### New section in `startIpcWatcher`
Scans `{ipcBaseDir}/{group}/things-requests/` each poll cycle:
- Reads each `.json` request file: `{ requestId, command, cliArgs: string[] }`
- Deletes the request file atomically before processing (prevents double-processing)
- Calls `executeThingsCommand(requestId, command, cliArgs)`
- Writes response `{ result?, error? }` to `{ipcBaseDir}/{group}/things-responses/{requestId}.json` using atomic temp-then-rename

### New helper function
```typescript
function executeThingsCommand(requestId, command, cliArgs): { result?, error? }
```
- Reads `THINGS_AUTH_TOKEN` from `.env` via `readEnvFile`
- Runs `spawnSync(THINGS_BIN, [command, ...cliArgs])` with 10s timeout
- Returns `{ result: stdout }` on success or `{ error: stderr | exitCode }` on failure

## Request/response protocol

**Request** (written by container MCP server):
```json
{
  "requestId": "1234567890-abc123",
  "command": "today",
  "cliArgs": ["--json"],
  "groupFolder": "main",
  "timestamp": "2026-02-25T..."
}
```

**Response** (written by host):
```json
{ "result": "[{\"uuid\":\"...\",\"title\":\"...\"}]" }
// or on error:
{ "error": "stderr output or exit code message" }
```

## Invariants
- All existing IPC watcher behavior (messages, tasks) is preserved unchanged
- The Things request processing runs in the same poll loop as messages and tasks
- Error handling follows the same pattern: log the error, clean up the request file
- No changes to `processTaskIpc`, `IpcDeps`, or any other existing functions
- The `THINGS_AUTH_TOKEN` is passed to the subprocess environment when present; absent when not set (read operations still work without it)

## Must-keep
- All existing IPC watcher behavior unchanged
- Authorization model: only processes requests from registered group directories
- Atomic file operations (temp-then-rename) for response files
- Per-group directory isolation (`{ipcBaseDir}/{group}/things-requests/`)
