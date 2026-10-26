# Remove llmman

Idempotent — safe to run even if some steps were never applied.

## 1. Delete the copied files (both trees)

```bash
rm -f container/agent-runner/src/llmman-mcp-stdio.ts \
      container/agent-runner/src/llmman-registration.test.ts \
      src/llmman-env.ts \
      src/llmman-wiring.test.ts
```

## 2. Unregister the MCP server

In `container/agent-runner/src/index.ts`, remove the `llmman: { … }` entry from the `mcpServers` object (leave `nanoclaw` and any other entries).

## 3. Revert the host-side edits

- Remove the `import { llmmanEnv } from './llmman-env.js';` import.
- Remove the `...llmmanEnv(),` spread from the `contributedEnv` literal in `composeSessionSpec`.
- Remove the `[LLMMAN]` branch from the driver's stderr handler in `src/drivers/docker-driver.ts`. If `[LLMMAN]` was the only prefix branch, restore the handler to its single `log.debug(line, …)` form (keep the stderr-tail lines); if other local-model tools still have branches there, just drop the `[LLMMAN]` one and leave the rest intact.

## 4. Remove env vars

Remove the llmman block from `.env.example`, and the `LLMMAN_HOST` / `LLMMAN_API_KEY` / `LLMMAN_ADMIN_TOOLS` lines from `.env` if you set them. If you added a key to the daemon's `LLMMAN_API_KEYS` for this install, remove it there too.

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

After removal, confirm the tool is gone — in a wired agent, asking it to "list llmman models" should report no such tool, and the logs should show no `[LLMMAN]` lines after the last restart:

```bash
grep "\[LLMMAN\]" logs/nanoclaw.log | tail -5
```
