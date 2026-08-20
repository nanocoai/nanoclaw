# Remove Atomic Chat

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server from every group that has it

The registration is per agent group, in the group's container config. List the groups, then check each one's config for an `atomic_chat` entry under `mcp_servers`:

```bash
ncl groups list
ncl groups config get --id <agent-group-id>
```

For each group that has it:

```bash
ncl groups config remove-mcp-server --id <agent-group-id> --name atomic_chat
ncl groups restart --id <agent-group-id>
```

Until the group restarts, its running container still has the tool.

## 2. Delete the copied files

```bash
rm -f container/agent-runner/src/atomic-chat-mcp-stdio.ts \
      container/agent-runner/src/atomic-chat-mcp-stdio.test.ts \
      src/atomic-chat-wiring.test.ts
```

## 3. Revert the optional log edit

If you applied it: in `src/drivers/docker-driver.ts`, inside `DockerHandle.start()`, restore the stderr handler to its single `log.debug(line, { container: this.name })` form — remove the `[ATOMIC]` info-level branch and keep the stderr-tail lines. If another local-model tool (e.g. `add-ollama-tool`) added its own prefix branch, leave that one alone.

## 4. Rebuild the host

```bash
pnpm run build
```

No image rebuild and no service restart are needed: the agent-runner source is a read-only bind mount, and nothing in the host process holds Atomic Chat state. (If you reverted the log edit, the running host keeps the old behavior until it is restarted — harmless, and it goes away on the next restart.)

## Verification

```bash
ncl groups config get --id <agent-group-id>    # no atomic_chat under mcp_servers
grep -rl atomic-chat container/agent-runner/src src   # no matches
```

In a wired agent, asking it to "list atomic chat models" should report no such tool, and no new `[ATOMIC]` lines should appear in `logs/nanoclaw.log`:

```bash
grep "\[ATOMIC\]" logs/nanoclaw.log | tail -5
```
