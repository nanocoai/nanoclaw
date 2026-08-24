---
name: debug
description: Debug container agent issues. Use when things aren't working, container fails, authentication problems, or to understand how the container system works. Covers logs, session DBs, mounts, and common issues.
---

# NanoClaw Container Debugging

This guide covers debugging the containerized agent execution system.

## Architecture Overview

The host is a single Node process that orchestrates per-session agent containers. The two session DBs are the **sole** IO surface between host and container — there is no IPC, no file watcher, and no stdin piping.

```
Host (Node)                                Container (Bun, Linux VM)
──────────────────────────────────────────────────────────────────────
src/container-runner.ts                    container/agent-runner/src/
    │                                          │
    │ spawns one container per session          │ polls inbound.db for work,
    │ with the session folder mounted          │ calls the agent provider,
    │ at /workspace                            │ writes replies to outbound.db
    │                                          │
    ├── data/v2-sessions/<group>/<session>/ ──> /workspace
    │     ├── inbound.db   (host writes, container reads RO)
    │     ├── outbound.db  (container writes, host reads)
    │     └── .heartbeat   (container touches → /workspace/.heartbeat)
    ├── groups/<folder> ─────────────────────> /workspace/agent  (cwd)
    ├── <group>/.claude-shared ──────────────> /home/node/.claude
    └── agent-runner src + skills ───────────> /app/src, /app/skills
```

**Message flow:** host writes a row to `inbound.db` (`messages_in`) and wakes the container; the container's poll loop picks it up, runs the agent, and writes the reply to `outbound.db` (`messages_out`); the host's delivery poll reads `messages_out` and sends it through the channel adapter. See [docs/db.md](../../../docs/db.md) and [docs/db-session.md](../../../docs/db-session.md) for the full two-DB model.

**Container identity:** the container runs as user `node` with `HOME=/home/node`. Per-group Claude state (settings, session history) lives in `<group>/.claude-shared` on the host, mounted to `/home/node/.claude`.

## Log Locations

| Log | Location | Content |
|-----|----------|---------|
| **Host errors** | `logs/nanoclaw.error.log` | Delivery failures, crash-loop backoff, warnings — check this first |
| **Host app log** | `logs/nanoclaw.log` | Full routing chain: inbound routing, container spawn/exit, delivery |
| **Setup logs** | `logs/setup.log`, `logs/setup-steps/*.log` | Per-step install output (bootstrap, container, onecli, mounts, service) |
| **Session inbound** | `data/v2-sessions/<group>/<session>/inbound.db` (`messages_in`) | Did the message reach the container? |
| **Session outbound** | `data/v2-sessions/<group>/<session>/outbound.db` (`messages_out`) | Did the agent produce a reply? |

Containers run with `--rm`, so the container's own filesystem is gone after it exits. The host streams container **stderr** into `logs/nanoclaw.log` at debug level, tagged with `container=<group folder>`; raise the log level (below) to see it. If the agent silently failed inside an exited container, there is no persistent in-container log — reconstruct from the session DBs and the host log.

## Enabling Debug Logging

Set `LOG_LEVEL=debug` for verbose output, including streamed container stderr:

```bash
# For development
LOG_LEVEL=debug pnpm run dev

# For launchd service (macOS), add to plist EnvironmentVariables:
<key>LOG_LEVEL</key>
<string>debug</string>
# For systemd service (Linux), add to unit [Service] section:
# Environment=LOG_LEVEL=debug
```

Debug level shows full mount configurations, the container spawn command, and streamed container stderr lines.

## Inspecting Session DBs

The two session DBs are where the message flow lives. Use the in-tree query wrapper (it goes through the `better-sqlite3` dep that setup already installs, avoiding a dependency on the `sqlite3` CLI):

```bash
# List sessions and their agent group / messaging group from the central DB
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, agent_group_id, messaging_group_id, status, container_status, last_active FROM sessions"

# Or via the admin CLI
ncl sessions list

# Did the message reach the container? (inbound.db, host writes / container reads)
pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<session>/inbound.db \
  "SELECT seq, kind, status, timestamp FROM messages_in ORDER BY seq DESC LIMIT 10"

# Did the agent produce a reply? (outbound.db, container writes / host reads)
pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<session>/outbound.db \
  "SELECT seq, kind, timestamp FROM messages_out ORDER BY seq DESC LIMIT 10"

# Container-side processing status for each inbound message
pnpm exec tsx scripts/q.ts data/v2-sessions/<group>/<session>/outbound.db \
  "SELECT message_id, status, status_changed FROM processing_ack ORDER BY status_changed DESC LIMIT 10"
```

Reading the flow:
- `messages_in` has the message but no matching `messages_out` → the container never produced a reply (check `processing_ack`, then `logs/nanoclaw.log` for spawn/exit and container stderr).
- `messages_out` has a reply but the user never received it → a delivery problem (see issue 1 below).
- `messages_in` is empty → routing never reached this session (check the router log lines and the central wiring with `ncl wirings list`).

## Common Issues

### 1. "No adapter for channel type" / Messages silently lost (null platform_message_id)

**Symptom:** The bot stops replying. `logs/nanoclaw.error.log` shows repeated:
```
WARN No adapter for channel type channelType="telegram"
WARN No adapter for channel type channelType="signal"
```
The main log shows "Message delivered" entries with `platformMsgId=undefined` — meaning the delivery poll ran, found no adapter, and marked the message delivered without sending it.

**Root cause: two NanoClaw service instances running simultaneously.**

When a second service instance is active with a stale binary, it has no channel adapters registered. Its delivery poll races the working instance and wins — marking outbound messages delivered without ever sending them.

**Diagnosis:**
```bash
# Check for duplicate running instances
ps aux | grep 'nanoclaw/dist/index.js' | grep -v grep

# Check which services are active (Linux)
systemctl --user list-units 'nanoclaw*' --all

# Confirm channel adapters registered by the current process
grep "Channel adapter started" logs/nanoclaw.log | tail -10
```

**Fix:**
1. Identify which service has the correct binary and EnvironmentFile (the one whose log shows the expected channels — e.g. `signal`, `telegram`, `cli` — all started).
2. Stop and disable the stale duplicate service:
   ```bash
   systemctl --user stop nanoclaw.service   # or whichever is the old one
   systemctl --user disable nanoclaw.service
   ```
3. If the remaining service unit is missing `EnvironmentFile`, add it:
   ```bash
   # Edit the service unit — add this line under [Service]:
   # EnvironmentFile=/home/[user]/nanoclaw/.env
   systemctl --user daemon-reload
   systemctl --user restart nanoclaw-v2-<id>.service
   ```
4. Verify only one instance runs: `ps aux | grep nanoclaw/dist/index.js | grep -v grep`

Messages marked delivered with a null `platform_message_id` are not automatically retried. Ask the user to resend.

### 2. Container exits immediately / agent produces no reply

A spawned container that exits without writing to `outbound.db` shows up in `logs/nanoclaw.log` as a `Container exited` line with a non-zero `code`, often preceded by streamed `container=<folder>` stderr (at debug level).

**Authentication errors:** secrets are injected per request by the OneCLI gateway — none are passed in env vars or chat context. A `401` from an API whose credential is in the vault usually means the agent is in `selective` secret mode and that secret was never assigned:
```bash
onecli agents list                                        # check secretMode
onecli agents set-secret-mode --id <agent-id> --mode all  # inject all matching secrets
```
If the gateway itself is unreachable, the container runner refuses to spawn (`OneCLI gateway not applied — refusing to spawn container without credentials` in the host log). Confirm the gateway is up at `http://127.0.0.1:10254`.

**MCP server failures:** a misconfigured MCP server can abort the agent run. Look for MCP initialization errors in the streamed container stderr (`LOG_LEVEL=debug`).

### 3. Mount Issues

Session and group folders are bind-mounted into the container. To see the resolved mounts for a spawn, run with `LOG_LEVEL=debug` and read the spawn command in `logs/nanoclaw.log`, or grep the mount targets directly:

```bash
grep -n "containerPath" src/container-runner.ts
```

Expected mount targets inside the container:
```
/workspace            ← session folder (inbound.db, outbound.db, .heartbeat, inbox/, outbox/)
/workspace/agent      ← agent group folder (cwd; CLAUDE.md, skills, working files)
/home/node/.claude    ← per-group .claude-shared (Claude state, settings, history)
/app/src              ← agent-runner source (read-only)
/app/skills           ← container skills (read-only)
```

To inspect what a fresh container sees:
```bash
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'whoami; ls -la /workspace/ /app/'
```
All of `/workspace/` and `/app/` should be owned by `node`. Use `:ro` on a `-v` mount for read-only.

### 4. Heartbeat / stale-session detection

Liveness is a file `touch` on `/workspace/.heartbeat` (host path: `data/v2-sessions/<group>/<session>/.heartbeat`), not a DB write. The host sweep reads its mtime plus the `processing_ack` claim age to decide whether a container is alive or stale. A session stuck "processing" with a stale `.heartbeat` mtime means the container died mid-run:

```bash
stat -f '%Sm' data/v2-sessions/<group>/<session>/.heartbeat   # macOS
stat -c '%y'  data/v2-sessions/<group>/<session>/.heartbeat   # Linux
```

## Container CLI (`ncl`) inside a session

The agent reaches the central DB from inside the container via `ncl`, which uses the session DB transport (`container/agent-runner/src/cli/ncl.ts`). On the host, `ncl` connects over a Unix socket (`src/cli/socket-server.ts`). If `ncl` calls fail from inside a container, check the agent group's `cli_scope` in its container config:

```bash
ncl groups config get --id <group-id>   # look at cli_scope: disabled | group | global
```

`disabled` rejects every `cli_request`; `group` scopes the agent to its own group's `groups`/`sessions`/`destinations`/`members`; `global` is unrestricted.

## Restarting a session's container

```bash
# Restart all containers for an agent group
ncl groups restart --id <group-id>

# Restart and rebuild the image first (after package/Dockerfile changes)
ncl groups restart --id <group-id> --rebuild

# Restart and wake immediately with a message
ncl groups restart --id <group-id> --message "on_wake test"
```

Without `--message`, the container comes back on the next user message. From inside a container, `--id` is auto-filled and only the calling session restarts.

## Manual Container Probes

The container's entry point is `exec bun run /app/src/index.ts`; it talks only to the mounted session DBs, so there is no JSON to pipe in. To probe the image directly:

```bash
# Interactive shell in the image
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest

# Check the image contents
docker run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c '
  node --version
  bun --version
  ls /app/src/
'
```

## Provider SDK Options

The default provider wraps the Claude Agent SDK in `container/agent-runner/src/providers/claude.ts`. The query is configured roughly as:

```typescript
query({
  prompt: input.prompt,
  options: {
    cwd: input.cwd,                 // /workspace/agent
    allowedTools: [...TOOL_ALLOWLIST, ...mcpAllowPatterns],
    disallowedTools: SDK_DISALLOWED_TOOLS,
    permissionMode: 'bypassPermissions',
    settingSources: ['project', 'user', 'local'],
    mcpServers: { ... },
  },
})
```

Each registered MCP server's allow pattern is derived from the `mcpServers` map, so registering a server already exposes its tools.

## Rebuilding After Changes

```bash
# Rebuild host TypeScript
pnpm run build

# Rebuild the agent container image
./container/build.sh

# Force a truly clean rebuild (the buildkit cache retains stale COPY files)
docker builder prune -af
./container/build.sh
```

## Clearing a Session

Conversation continuity lives in the container-owned `session_state` table in `outbound.db` (the provider's session/continuation id). The agent's `/clear` clears it. To reset a session from the host, remove the session folder so a fresh one is provisioned on the next message:

```bash
# Inspect first
ncl sessions get <session-id>

# Remove a single session's folder (host re-provisions both DBs on next message)
rm -rf data/v2-sessions/<group>/<session>/
```

## Quick Diagnostic Script

```bash
echo "=== Checking NanoClaw v2 Setup ==="

echo -e "\n1. Container runtime running?"
docker info &>/dev/null && echo "OK" || echo "NOT RUNNING - start Docker Desktop (macOS) or sudo systemctl start docker (Linux)"

echo -e "\n2. Agent image exists?"
docker run --rm --entrypoint /bin/echo nanoclaw-agent:latest "OK" 2>/dev/null || echo "MISSING - run ./container/build.sh"

echo -e "\n3. OneCLI gateway reachable?"
curl -fsS http://127.0.0.1:10254/ >/dev/null 2>&1 && echo "OK" || echo "CHECK - gateway not responding on 127.0.0.1:10254"

echo -e "\n4. Central DB present?"
[ -f data/v2.db ] && echo "OK" || echo "MISSING - run setup"

echo -e "\n5. Mount targets in container-runner?"
grep -q "containerPath: '/workspace'" src/container-runner.ts && echo "OK" || echo "CHECK - session mount target changed"

echo -e "\n6. Single host instance running?"
N=$(ps aux | grep 'nanoclaw/dist/index.js' | grep -vc grep)
[ "$N" -le 1 ] && echo "OK ($N)" || echo "DUPLICATE - $N instances; stop the stale one (see issue 1)"

echo -e "\n7. Recent host errors?"
tail -n 5 logs/nanoclaw.error.log 2>/dev/null || echo "No error log yet"
```
