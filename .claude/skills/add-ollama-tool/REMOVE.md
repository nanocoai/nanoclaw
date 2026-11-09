# Remove Ollama

Idempotent — safe to run even if some steps were never applied.

## 1. Delete the copied files (both trees)

```bash
rm -f container/agent-runner/src/ollama-mcp-stdio.ts \
      container/agent-runner/src/ollama-registration.test.ts \
      src/ollama-env.ts \
      src/ollama-wiring.test.ts
```

## 2. Unregister the MCP server

In `container/agent-runner/src/index.ts`, remove the `ollama: { … }` entry from the `mcpServers` object (leave `nanoclaw` and any other entries).

## 3. Revert the host-side edits

- Remove the `import { ollamaEnv } from './ollama-env.js';` import.
- Remove the `...ollamaEnv(),` spread from the `env` literal in `composeSessionSpec`.
- Remove the `[OLLAMA]` branch from the driver's stderr handler in `src/drivers/docker-driver.ts`. If `[OLLAMA]` was the only prefix branch, restore the handler to its single `log.debug(line, …)` form (keep the stderr-tail lines); if other local-model tools still have branches there, just drop the `[OLLAMA]` one and leave the rest intact.

## 4. Remove env vars

Remove the Ollama block from `.env.example`, and the `OLLAMA_HOST` / `OLLAMA_ADMIN_TOOLS` lines from `.env` if you set them.

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

After removal, confirm the tool is gone — in a wired agent, asking it to "list ollama models" should report no such tool, and the logs should show no `[OLLAMA]` lines after the last restart:

```bash
grep "\[OLLAMA\]" logs/nanoclaw.log | tail -5
```
