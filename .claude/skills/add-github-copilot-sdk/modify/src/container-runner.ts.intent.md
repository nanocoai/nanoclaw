# Intent: src/container-runner.ts modifications

## What changed
Updated host-side container runner for Copilot SDK session persistence and authentication. Changed volume mounts from `.claude` to `.copilot`, replaced Claude/Anthropic secrets with GitHub secrets, added skills directory bind mount.

## Key sections

### Session persistence mount
- Changed: `groupSessionsDir` from `sessions/<folder>/.claude` to `sessions/<folder>/.copilot`
- Changed: container mount target from `/home/node/.claude` to `/home/node/.copilot`

### Skills directory mount
- Added: read-only bind mount of `container/skills/` to `/workspace/skills/` (for Copilot SDK's native `skillDirectories` config)

### Secret handling
- Changed: reads `GITHUB_TOKEN` and `GH_TOKEN` from `.env` instead of `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
- Secrets passed to container via stdin JSON (same mechanism)

### Removed
- Claude Code settings.json generation (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_ADDITIONAL_DIRECTORIES`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`)
- Manual skills filesystem copy (replaced by bind mount)

## Invariants
- Container spawn mechanism unchanged (child_process.spawn)
- Volume mount architecture unchanged (group dir, global dir, IPC dirs, extra dirs)
- Output parsing unchanged (sentinel markers in stdout)
- Streaming callback pattern unchanged
- Container naming convention unchanged (`nanoclaw-<folder>-<timestamp>`)
- Mount security (allowlist validation) unchanged

### Model routing
- Added: `model?: string` field to `ContainerInput` interface
- Added: Promotes agent-runner model logs (Available models, Requested model, Session ready) from DEBUG to INFO level via pattern matching on container stderr lines

## Must-keep
- `runContainerAgent()` function signature and return type
- `writeGroupsSnapshot()` and `writeTasksSnapshot()` exports
- `AvailableGroup` type export
- The stdin JSON → container → stdout sentinel protocol
- IPC directory mounts (`/workspace/ipc/`)
- Extra directory mounts with mount allowlist validation
- CLAUDE.md file discovery and mounting to `/workspace/extra/`
