---
name: add-things
description: "macOS only. Add Things 3 task management to NanoClaw. The agent can list, search, add, update, complete, and delete todos in Things 3 via the things3-cli. Triggers on \"add things\", \"things integration\", \"task management\", or \"Things 3 support\"."
---

# Add Things 3 Integration

> **macOS only.** Things 3 is a macOS/iOS application. This skill requires the host system to be running macOS. It will not work on Linux.

This skill adds Things 3 task management to NanoClaw. All operations run through the `things3-cli` binary on the macOS host via IPC — no direct database access or mounting required.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `things` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Check prerequisites

1. **macOS only**: Things 3 runs on macOS. Verify the host is macOS:

```bash
uname -s
```

If the output is not `Darwin`, stop and inform the user: **This skill is macOS-only and cannot be installed on this system.**

2. **Things 3 installed**: Ask the user to confirm Things 3 is installed and running.

3. **things3-cli installed**: Check for the binary:

```bash
ls /opt/homebrew/bin/things 2>/dev/null || ls /usr/local/bin/things 2>/dev/null && echo "found" || echo "not found"
```

If not found, install it:

```bash
brew tap ossianhempel/tap
brew install things3-cli
```

Homebrew tap: `ossianhempel/tap`, formula: `things3-cli`
- Apple Silicon: `/opt/homebrew/bin/things`
- Intel Mac: `/usr/local/bin/things`

4. **Things auth token**: The auth token is required for write operations (add, update, delete). Ask the user for their Things URL Scheme Authorization Token:

> To find your Things auth token:
> 1. Open Things 3
> 2. Go to **Things** → **Preferences** → **General**
> 3. Enable **Things URLs**
> 4. Click **Manage** next to "Things URLs"
> 5. Copy the authorization token shown there

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-things
```

This deterministically:
- Adds `container/skills/things/SKILL.md` (container agent skill — auto-loaded by every agent session)
- Three-way merges Things IPC handler into `src/ipc.ts` (host-side CLI execution)
- Three-way merges Things MCP tools into `container/agent-runner/src/ipc-mcp-stdio.ts` (container-side MCP server)
- Updates `.env.example` with `THINGS_AUTH_TOKEN` and `THINGS_BIN`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/ipc.ts.intent.md` — what changed and invariants for ipc.ts
- `modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md` — what changed for the MCP server

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
THINGS_AUTH_TOKEN=<token-from-phase-1>
# Optional: override binary path (default: /opt/homebrew/bin/things)
# THINGS_BIN=/usr/local/bin/things
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Sync container source

The container agent-runner source cache must be updated to pick up the new MCP tools:

```bash
cp container/agent-runner/src/ipc-mcp-stdio.ts data/sessions/main/agent-runner-src/ipc-mcp-stdio.ts
```

If other groups exist, sync them too:

```bash
for d in data/sessions/*/agent-runner-src/; do
  cp container/agent-runner/src/ipc-mcp-stdio.ts "$d/ipc-mcp-stdio.ts"
done
```

> **Why is this needed?** The per-group `data/sessions/{group}/agent-runner-src/` cache is copied from `container/agent-runner/src/` only on the first run — it is never auto-updated. The container compiles the MCP server from this cache at startup, not from the container image.

### Build and restart

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

On Linux (systemd):

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test the integration

Send a message to your main NanoClaw channel:

> What's on my Things Today list?

The agent should respond with your today's tasks from Things 3.

Try adding a task:

> Add "Test Things integration" to Things with tag "test"

And then verify it appeared:

> Search Things for "Test Things integration"

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i things
```

## Troubleshooting

### "Things CLI returned non-zero exit code"

1. Verify the binary exists and is executable:
   ```bash
   /opt/homebrew/bin/things --version
   ```
2. Check `THINGS_AUTH_TOKEN` is set correctly in `.env` and synced to `data/env/env`
3. Verify Things 3 is running on the host

### "Things request timed out"

The IPC request was written but the host didn't respond within 10 seconds.

1. Check the host service is running: `launchctl list | grep nanoclaw`
2. Check for errors: `tail -f logs/nanoclaw.log`
3. Verify `data/ipc/main/things-requests/` directory is being processed

### MCP tools not available in agent

The container is running old compiled MCP server code.

1. Sync updated source:
   ```bash
   cp container/agent-runner/src/ipc-mcp-stdio.ts data/sessions/main/agent-runner-src/ipc-mcp-stdio.ts
   ```
2. Rebuild container: `./container/build.sh`
3. Restart service

### Read operations work but write operations fail

`THINGS_AUTH_TOKEN` is missing or incorrect. Write operations (add, update, delete) require the auth token. Read operations (list, search) work without it.

1. Get token from Things → Preferences → General → Things URLs → Manage
2. Add to `.env`: `THINGS_AUTH_TOKEN=your-token`
3. Sync: `cp .env data/env/env`
4. Restart service

### Binary not found

The `things` binary isn't in the expected location.

1. Find it: `which things || find /opt/homebrew /usr/local -name things 2>/dev/null`
2. Set `THINGS_BIN=/actual/path/to/things` in `.env`
3. Sync and restart

## Available Tools (in container agent)

Once installed, the container agent can use:

| Tool | Purpose |
|------|---------|
| `things_list` | List todos by view (today, inbox, upcoming, anytime, someday, logbook, projects, areas, tags) |
| `things_search` | Search todos by keyword |
| `things_add` | Add a new todo |
| `things_update` | Update, complete, cancel, or reschedule a todo |
| `things_delete` | Delete (trash) a todo |

See `container/skills/things/SKILL.md` for full tool documentation.
