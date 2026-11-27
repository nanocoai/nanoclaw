# Intent: container/Dockerfile modifications

## What changed
Replaced Claude Code CLI installation with GitHub CLI (`gh`) for Copilot SDK authentication. Updated comments to reference Copilot SDK instead of Claude Agent SDK.

## Key sections
- **GitHub CLI install**: Added `curl` + `apt-get install gh` block for Copilot SDK auth token flow
- **Removed**: `npm install -g @anthropic-ai/claude-code` (no longer needed)
- **Comments**: Updated header comment to say "GitHub Copilot SDK" instead of "Claude Agent SDK"
- **Entrypoint**: Uses `exec node` — stdin pipes directly to Node process. Secrets are never written to disk (no intermediate temp file). The `exec` replaces the shell process so there's no parent shell lingering with access to the pipe data.

## Invariants
- Base image remains `node:22-slim`
- Chromium and system dependencies unchanged (agent-browser needs them)
- `agent-browser` global install unchanged
- Workspace directory structure unchanged (`/workspace/group`, `/workspace/global`, etc.)
- Non-root `node` user for security unchanged
- Entrypoint script pattern unchanged (stdin JSON → node process)

## Must-keep
- All Chromium-related apt packages (required for agent-browser)
- `AGENT_BROWSER_EXECUTABLE_PATH` and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` env vars
- The workspace directory creation (`mkdir -p /workspace/...`)
- The entrypoint.sh pattern (compile → exec node with stdin piped directly, no temp file)
- `USER node` for non-root security
- `WORKDIR /workspace/group`
