# Intent: container/agent-runner/src/ipc-mcp-stdio.ts modifications

## What changed

Added five Things 3 MCP tools to the container's stdio MCP server. The agent can now call `things_list`, `things_search`, `things_add`, `things_update`, and `things_delete` from within the container. All calls go through a shared `thingsRequest()` helper that uses file-based IPC to communicate with the host.

## Key additions

### New directory constants
```typescript
const THINGS_REQUESTS_DIR = path.join(IPC_DIR, 'things-requests');
const THINGS_RESPONSES_DIR = path.join(IPC_DIR, 'things-responses');
```

These mirror the directories watched by the host-side IPC handler in `src/ipc.ts`.

### New helper: `thingsRequest(command, cliArgs)`

Shared async helper used by all five tools:
1. Generates a unique `requestId`
2. Writes a request JSON file to `THINGS_REQUESTS_DIR` via `writeIpcFile`
3. Polls `THINGS_RESPONSES_DIR/{requestId}.json` every 200ms
4. Returns result text or error text after host processes the request
5. Times out after 10 seconds

**Request format written**:
```json
{ "requestId": "...", "command": "today", "cliArgs": ["--json"], "groupFolder": "...", "timestamp": "..." }
```

**Response format expected**:
```json
{ "result": "..." }  // or  { "error": "..." }
```

### Five new MCP tools

| Tool | CLI command | Description |
|------|-------------|-------------|
| `things_list` | `things {view} --json [filters...]` | List todos by view |
| `things_search` | `things search --json [--limit] [--status] -- {query}` | Search todos |
| `things_add` | `things add [options] -- {title}` | Add a new todo |
| `things_update` | `things update --id={id} [options]` | Update/complete/cancel a todo |
| `things_delete` | `things delete --id={id} --confirm={id}` | Delete (trash) a todo |

### CLI argument construction

Each tool pre-builds the `cliArgs: string[]` array before calling `thingsRequest`. The host simply runs `spawnSync(THINGS_BIN, [command, ...cliArgs])`.

- List/search tools always pass `--json` as first arg for structured output
- Optional args use `--key=value` format (no separate value arg)
- Title/query args use `--` separator before positional arg
- Boolean flags (`--completed`, `--canceled`) use bare flag or `--flag=false`

## Invariants
- All existing tools (`send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `register_group`) are preserved unchanged
- New tools are added in a clearly delimited section: `// ── Things 3 integration ────`
- `thingsRequest` uses `writeIpcFile` (same atomic write helper as other tools)
- No new imports required (uses existing `fs`, `path`, `z`, `server`)
- Context variables (`chatJid`, `groupFolder`, `isMain`) are available and `groupFolder` is included in requests for host-side logging

## Must-keep
- All existing MCP tool definitions unchanged
- The `writeIpcFile` atomic write pattern
- The `IPC_DIR = '/workspace/ipc'` constant (maps to the host's `data/ipc/{group}/` directory)
- Server connection at the bottom: `await server.connect(transport)`

## Important note on cache sync

After modifying this file, the per-group session cache must be manually synced:
```bash
cp container/agent-runner/src/ipc-mcp-stdio.ts data/sessions/main/agent-runner-src/ipc-mcp-stdio.ts
```
The cache at `data/sessions/{group}/agent-runner-src/` is only populated on first run and never auto-updated. The container compiles its MCP server from this cache, not from the container image.
