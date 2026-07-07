# Remove Atomic Chat

Idempotent — safe to run even if some steps were never applied.

## 1. Delete the copied files (both trees)

```bash
rm -f container/agent-runner/src/atomic-chat-mcp-stdio.ts \
      container/agent-runner/src/atomic-chat-registration.test.ts \
      src/atomic-chat-env.ts \
      src/atomic-chat-wiring.test.ts
```

## 2. Unregister the MCP server

In `container/agent-runner/src/index.ts`, remove the `atomic_chat: { … }` entry from the `mcpServers` object (leave `nanoclaw` and any other entries).

## 3. Revert the host-side edits in `src/container-runner.ts`

- Remove the `import { atomicChatEnvArgs } from './atomic-chat-env.js';` import.
- Remove the `args.push(...atomicChatEnvArgs());` line that follows the `TZ` env line.
- Restore the `container.stderr` logger to its single-line `log.debug(line, …)` form (remove the `[ATOMIC]` info-level branch).

## 4. Remove env vars

Remove the Atomic Chat block from `.env.example`, and the `ATOMIC_CHAT_*` lines from `.env` if you set them.

## 5. Rebuild and restart

Run from your NanoClaw project root:

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## Verification

After removal, confirm the tool is gone — in a wired agent, asking it to "list atomic chat models" should report no such tool, and the logs should show no `[ATOMIC]` lines after the last restart:

```bash
grep "\[ATOMIC\]" logs/nanoclaw.log | tail -5
```
