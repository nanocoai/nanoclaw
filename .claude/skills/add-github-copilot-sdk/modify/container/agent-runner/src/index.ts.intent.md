# Intent: container/agent-runner/src/index.ts modifications

## What changed
Complete rewrite of the agent runner from Claude Agent SDK (`ClaudeClient`/`Session`) to GitHub Copilot SDK (`CopilotClient`/`CopilotSession`). Same overall architecture: read JSON input from stdin, create/resume a session, send prompt, stream results via stdout sentinels, archive conversation.

## Key sections

### Imports
- Replaced: `ClaudeClient`, `Session` from `@anthropic-ai/claude-agent-sdk`
- Added: `CopilotClient`, `CopilotSession`, `SessionConfig`, `ResumeSessionConfig`, `SessionEvent` from `@github/copilot-sdk`
- Added: `PermissionRequest`, `PermissionRequestResult` type imports for custom permission handler

### Authentication
- Replaced: `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` extraction
- Added: `githubToken` extracted from `secrets.GITHUB_TOKEN || secrets.GH_TOKEN`
- Client construction: `new CopilotClient({ githubToken, env: minimalEnv })` — passes minimal env to isolate CLI subprocess

### Session lifecycle
- `client.createSession(config)` / `client.resumeSession(config)` instead of `client.newSession()` / `client.resume()`
- `session.sendAndWait(prompt, { timeout: 600_000 })` instead of `session.send(prompt)`
- `client.stop()` / `client.forceStop()` for cleanup instead of `session.destroy()`

### Session config
- `configDir: '/home/node/.copilot'` for session persistence
- `skillDirectories` discovered from `/workspace/skills/`
- `systemMessage: { content: systemPrompt, mode: 'append' }` instead of `systemPrompt` string
- Custom `onPermissionRequest` handler returning `{ kind: 'approved' }` for headless operation
- MCP servers configured with `tools: ['*']` wildcard
- `model` field from `containerInput.model` for per-request model selection

### Model logging
- After `client.start()`: calls `client.listModels()` and logs all available model IDs
- Before session creation: logs the requested model from `containerInput.model`
- After session creation: calls `session.rpc.model.getCurrent()` and logs the resolved model ID

### Security hardening

**Minimal CLI environment** (`env` option on CopilotClient):
- Passes only `HOME`, `PATH`, `NODE_OPTIONS`, `LANG` to CLI subprocess
- Prevents CLI child from inheriting host secrets via `process.env`
- Limits what `/proc/<pid>/environ` exposes inside the container

**Post-init secret scrubbing** (after `client.start()`):
- Deletes `containerInput.secrets` and `containerInput.githubToken` from memory
- Clears `process.env.COPILOT_SDK_AUTH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`
- Token is already passed to CLI subprocess — no longer needed in agent-runner

**Hardened onPreToolUse hook**:
- Bash commands: injects `unset` prefix for all secret env vars
- Bash commands: blocks any command reading `/proc/*/environ` (returns deny)
- File read tools (Read, ReadFile): blocks reads of sensitive paths
- `SENSITIVE_PATH_PATTERNS`: `/proc/*/environ`, `/tmp/input.json` (legacy)

**Entrypoint change** (Dockerfile):
- Stdin piped directly to Node via `exec` — no intermediate temp file
- Eliminates race condition where `/tmp/input.json` contained secrets on disk

### Secret stripping (onPreToolUse hook)
- `ALWAYS_STRIP_VARS = ['COPILOT_SDK_AUTH_TOKEN']`
- Dynamic: `Object.keys(containerInput.secrets)` computed at runtime
- Injects `unset` commands before bash tool calls to prevent secret leakage
- Blocks `/proc/*/environ` reads via Bash with `permissionDecision: 'deny'`
- Blocks file reads of sensitive paths (Read/ReadFile tools) with path pattern matching

### Session events
- `session.compaction_start` for context window compaction logging
- `session.error` for error handling
- `onSessionEnd` hook for crash-safe conversation archiving

### Shutdown
- `client.stop()` returns `stopErrors` array (logged as warnings)
- `client.forceStop()` as fallback via `Promise.race` with 5s timeout

## Invariants
- Stdin JSON format unchanged (`ContainerInput` type)
- Stdout sentinel protocol unchanged (`OUTPUT_START_MARKER` / `OUTPUT_END_MARKER`)
- IPC file watcher pattern unchanged (watches `/workspace/ipc/input/`)
- MCP server setup unchanged (tools served via `@modelcontextprotocol/sdk`)
- System prompt construction unchanged (reads CLAUDE.md files, injects group context)
- Conversation archiving format unchanged (markdown in `/workspace/group/conversations/`)

## Must-keep
- `ContainerInput` / `ContainerOutput` / `ContainerResultOutput` type definitions
- `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` sentinel constants
- `buildSystemPrompt()` function (reads CLAUDE.md, injects context)
- `archiveConversation()` function
- `startIpcInputWatcher()` function (file-based follow-up messages)
- IPC MCP server (tools for scheduling, messaging, registration)
- The stdin → process → stdout pipeline architecture
