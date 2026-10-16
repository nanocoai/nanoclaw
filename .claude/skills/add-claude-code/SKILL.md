---
name: add-claude-code
description: Connect container agents to Claude Code on the host for coding tasks. Main group only — delegates file editing, debugging, and development work to a host-side Claude Code instance.
---

# Add Claude Code Integration

This skill connects your container agents to Claude Code running on the host machine. When the main agent needs to write code, debug, or make changes to the NanoClaw repository (or other allowed directories), it delegates to a Claude Code instance via an MCP tool.

## Architecture

```
Container (agent)                          Host (Mac Mini)
+----------------------------+    HTTP     +----------------------------+
| agent-runner/index.ts      |             | src/claude-code-service.ts |
|   |                        |             |   - HTTP server on :8282   |
|   +-> MCP: claude-code     |             |   - POST /invoke           |
|       (claude-code-proxy)  | ---------> |   - Spawns `claude -p`     |
|       stdio-to-HTTP bridge |  :8282      |   - Returns JSON result    |
+----------------------------+             +----------------------------+
```

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `claude-code` is in `applied_skills`, skip to Phase 3 (Verify). The code changes are already in place.

### Check prerequisites

1. Verify Claude Code CLI is installed on the host:

```bash
which claude
```

If not found, install it:

```bash
npm install -g @anthropic-ai/claude-code
```

2. Verify port 8282 is available:

```bash
lsof -i :8282
```

If something is using the port, it needs to be freed first.

3. Verify Claude Code CLI is authenticated. It works with either:
   - **Claude Max Plan**: CLI handles auth automatically (nothing to configure)
   - **API key**: Set `ANTHROPIC_API_KEY` in your `.env` file
   - **OAuth token**: Set `CLAUDE_CODE_OAUTH_TOKEN` in your `.env` file

   Test with:

```bash
claude -p "Say hi" --output-format text
```

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-claude-code
```

This deterministically:
- Adds `src/claude-code-service.ts` (host HTTP daemon)
- Adds `container/agent-runner/src/claude-code-proxy.ts` (container MCP proxy)
- Three-way merges Claude Code lifecycle into `src/index.ts` (start/stop service)
- Three-way merges Claude Code MCP server into `container/agent-runner/src/index.ts` (register MCP, allowedTools)

If the apply reports merge conflicts (common when the codebase has drifted since the last skill was applied), apply the changes manually instead:

1. The `add/` files will have been copied already — verify `src/claude-code-service.ts` and `container/agent-runner/src/claude-code-proxy.ts` exist
2. Read the intent files for what to change manually:
   - `modify/src/index.ts.intent.md` — 3 additions: import, shutdown call, startup call
   - `modify/container/agent-runner/src/index.ts.intent.md` — conditional MCP server + allowedTools registration
3. After manual edits, restore conflicted files from `.nanoclaw/backup/` if the merge left conflict markers
4. Run `npm run build` to verify, then record the application:

```bash
npx tsx -e "import{recordSkillApplication}from'./skills-engine/state.js';import{clearBackup}from'./skills-engine/backup.js';import crypto from'crypto';import fs from'fs';const h=(f:string)=>crypto.createHash('sha256').update(fs.readFileSync(f,'utf-8')).digest('hex');const files=['src/claude-code-service.ts','container/agent-runner/src/claude-code-proxy.ts','src/index.ts','container/agent-runner/src/index.ts'];const hashes=Object.fromEntries(files.map(f=>[f,h(f)]));recordSkillApplication('claude-code','1.0.0',hashes);clearBackup();console.log('Done');"
```

Note: If the inline `npx tsx -e` fails with module resolution errors, save it as a `.ts` file and run `npx tsx <file>.ts` instead.

### Configure CWD allowlist

The `src/claude-code-service.ts` file has a `CWD_ALLOWLIST` array near the top. By default it includes the NanoClaw project directory. If the agent should be able to work in other directories, add them now.

AskUserQuestion: Which directories should Claude Code be allowed to access? (NanoClaw project dir is included by default)

Update the `CWD_ALLOWLIST` in `src/claude-code-service.ts` with any additional paths.

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

### Sync agent-runner to session directories

The agent-runner source is mounted from `data/sessions/<group>/agent-runner-src/` at runtime. Sync the new proxy file (and the updated index.ts) to existing sessions:

```bash
for dir in data/sessions/*/agent-runner-src/; do
  cp container/agent-runner/src/claude-code-proxy.ts "$dir"
  cp container/agent-runner/src/index.ts "$dir"
done
```

## Phase 3: Verify

### Start the service

```bash
npm run dev
```

### Test health check

```bash
curl http://localhost:8282/health
```

Should return `{"status":"ok","active":false}`.

### Test a simple invocation

```bash
curl -X POST http://localhost:8282/invoke \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"List the files in the current directory","cwd":"$(pwd)"}'
```

Should return a JSON response with the file listing.

### Test security (CWD rejection)

```bash
curl -X POST http://localhost:8282/invoke \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"List files","cwd":"/tmp"}'
```

Should return an error about CWD not being in the allowlist.

### Test via Telegram

Send a message to the main agent asking it to perform a coding task, e.g.:

> "Use the code tool to check what TypeScript version we're using in package.json"

The agent should call `mcp__claude-code__code` and return the result.

## Troubleshooting

### Claude Code CLI not found

The service logs a warning at startup if `claude` isn't on PATH. Install it:

```bash
npm install -g @anthropic-ai/claude-code
```

If running via launchd, the CLI may not be in the minimal PATH. The service checks common locations (`/opt/homebrew/bin/claude`, `/usr/local/bin/claude`).

### Port 8282 in use

Another process is using the port. Find it:

```bash
lsof -i :8282
```

### Agent doesn't have the code tool

Only the **main group** gets the `claude-code` MCP server. Non-main groups intentionally don't have access. Check that the agent is running as the main group.

### Timeout errors

Claude Code invocations have a 5-minute timeout. For very large tasks, consider breaking them into smaller steps or increasing the timeout in `claude-code-service.ts`.

### Concurrency errors

Only one Claude Code invocation can run at a time. If the agent gets a "Another invocation is already in progress" error, it should wait and retry.

### CLI hangs (no output, no error)

The service uses `spawn` with `stdio: ['ignore', 'pipe', 'pipe']` to close stdin. If you see the CLI hanging with no output, verify that stdin is set to `'ignore'` in the spawn options. Using `execFile` or leaving stdin as `'pipe'` causes the CLI's shell detection subprocesses to hang waiting for input in non-TTY contexts (like launchd/systemd).

## Removal

To remove Claude Code integration:

1. Delete `src/claude-code-service.ts`
2. Delete `container/agent-runner/src/claude-code-proxy.ts`
3. Remove `startClaudeCodeService` / `stopClaudeCodeService` import and calls from `src/index.ts`
4. Remove `claude-code` MCP server registration and `mcp__claude-code__*` from allowed tools in `container/agent-runner/src/index.ts`
5. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
