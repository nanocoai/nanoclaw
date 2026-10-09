---
name: add-a2a
description: Add an A2A (Agent-to-Agent) channel so other AI agents (Claude Code, Cursor, Windsurf, etc.) can send tasks to your NanoClaw agent and receive streaming responses.
---

This skill adds an A2A-compatible HTTP endpoint to NanoClaw and optionally sets up the companion MCP adapter (`a2a-mcp`) so your AI coding assistant can call NanoClaw directly.

## Phase 1: Configuration

Ask the user:

1. **Port** — What port should the A2A channel listen on? Default: `41241`
2. **Web token** — The web dashboard requires a token in the URL to avoid confusion with A2A requests. Generate a random one or accept the default. Default: auto-generate with `openssl rand -hex 16`
3. **MCP setup** — Do you also want to set up the `a2a-mcp` companion so your coding assistant (Claude Code, Cursor, Windsurf) can call NanoClaw? (yes/no)

If yes to MCP setup, ask:
4. **Agent ID** — What name should identify your coding assistant to NanoClaw? Examples: `claude-code`, `cursor`, `windsurf`. Default: `claude-code`
5. **MCP install path** — Where should the `a2a-mcp` package be installed? Default: `~/Development/a2a-mcp`

Store answers as:
- `A2A_PORT` (default `41241`)
- `A2A_WEB_TOKEN` (generated or user-supplied)
- `SETUP_MCP` (yes/no)
- `MCP_AGENT_ID` (if SETUP_MCP=yes)
- `MCP_INSTALL_PATH` (if SETUP_MCP=yes, expand `~`)

---

## Phase 2: Apply channel code

Check if the channel is already installed:

```bash
test -f src/channels/a2a.ts && echo "exists" || echo "missing"
```

If missing, merge from the external repo:

```bash
git remote -v | grep nanoclaw-a2a || \
  git remote add nanoclaw-a2a https://github.com/sshwarts/nanoclaw-a2a.git

git fetch nanoclaw-a2a main
git merge nanoclaw-a2a/main --allow-unrelated-histories --no-edit || {
  # Auto-resolve package-lock.json conflicts
  git checkout --theirs package-lock.json 2>/dev/null
  git add package-lock.json 2>/dev/null
  git -c core.editor=true merge --continue 2>/dev/null || true
}
```

The merge adds `src/channels/a2a.ts`. Now wire it into the orchestrator.

### Wire into index.ts

Add the import after the SlackChannel import in `src/index.ts`:

```typescript
import { A2AChannel } from './channels/a2a.js';
```

Add the channel startup block after the Slack block (before `// Start subsystems`):

```typescript
  // Always start A2A channel on localhost
  const a2aEnv = readEnvFile(['A2A_PORT', 'A2A_WEB_TOKEN']);
  const a2aPort = a2aEnv.A2A_PORT ? parseInt(a2aEnv.A2A_PORT, 10) : 41241;
  const a2a = new A2AChannel({
    ...channelOpts,
    registerGroup,
    port: a2aPort,
    webToken: a2aEnv.A2A_WEB_TOKEN,
  });
  channels.push(a2a);
  await a2a.connect();
  logger.info({ port: a2aPort }, 'A2A channel listening');
```

---

## Phase 3: Configure environment

Append the A2A settings to `.env`:

```bash
printf '\n# A2A channel\nA2A_PORT=%s\nA2A_WEB_TOKEN=%s\n' \
  "<A2A_PORT>" "<A2A_WEB_TOKEN>" >> .env
```

---

## Phase 4: Set up a2a-mcp (if requested)

Skip this phase if `SETUP_MCP=no`.

### Install

```bash
git clone https://github.com/sshwarts/a2a-mcp.git "<MCP_INSTALL_PATH>"
cd "<MCP_INSTALL_PATH>"
npm install
npm run build
```

### Configure

```bash
cat > "<MCP_INSTALL_PATH>/config.json" <<EOF
{
  "agentId": "<MCP_AGENT_ID>",
  "agents": {
    "nanoclaw": "http://localhost:<A2A_PORT>"
  }
}
EOF
```

### Register with coding assistant

Detect which assistant the user has and show the relevant snippet. Ask if unsure.

**Claude Code** — add to `~/.claude/mcp.json` (create if missing):
```json
{
  "mcpServers": {
    "a2a-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["<MCP_INSTALL_PATH>/dist/index.js"]
    }
  }
}
```

**Cursor** — add to `~/.cursor/mcp.json`:
```json
{
  "mcpServers": {
    "a2a-mcp": {
      "command": "node",
      "args": ["<MCP_INSTALL_PATH>/dist/index.js"]
    }
  }
}
```

**Windsurf** — add to `~/.codeium/windsurf/mcp_config.json`:
```json
{
  "mcpServers": {
    "a2a-mcp": {
      "command": "node",
      "args": ["<MCP_INSTALL_PATH>/dist/index.js"]
    }
  }
}
```

---

## Phase 5: Build and restart

```bash
npm install && npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Wait 3 seconds, then verify the port is listening:

```bash
lsof -i :<A2A_PORT> | grep LISTEN
```

If the port is not listening, check logs:

```bash
tail -20 logs/nanoclaw.log
```

---

## Phase 6: Verify

### Test the A2A endpoint

```bash
echo '{"id":"test-1","sessionId":"test-1","message":{"role":"user","parts":[{"type":"text","text":"Hello, can you confirm the A2A channel is working?"}]}}' | \
  curl -s -X POST http://localhost:<A2A_PORT>/ \
    -H "Content-Type: application/json" \
    -H "X-Agent-ID: setup-test" \
    --data-binary @-
```

You should see an SSE stream ending with `"state":"completed"` and a response from the agent.

### Check the web dashboard

Open in a browser:
```
http://localhost:<A2A_PORT>/?token=<A2A_WEB_TOKEN>
```

The test message above should appear in the log.

### Test MCP (if installed)

Restart your coding assistant, then ask it to run `list_agents`. It should return `nanoclaw` as an available agent. Then try `ask_agent` with a simple message.

---

## Troubleshooting

**Port not listening after restart**
- Check `logs/nanoclaw.log` for errors
- Verify `A2A_PORT` is set correctly in `.env`
- Confirm the import and startup block were added to `src/index.ts`

**`ask_agent` tool not appearing in coding assistant**
- Restart the coding assistant after adding the MCP config
- Verify `<MCP_INSTALL_PATH>/dist/index.js` exists (`npm run build`)
- Check that `config.json` exists at the install path

**Agent not responding (timeout)**
- The agent has 120 seconds to respond — long tasks are fine
- Check that NanoClaw is running: `launchctl print gui/$(id -u)/com.nanoclaw | grep state`
- Check for errors in `logs/nanoclaw.log`

**Web dashboard shows 403**
- Ensure the `token` query parameter matches `A2A_WEB_TOKEN` in `.env`

---

## Removal

```bash
# Remove channel code
rm src/channels/a2a.ts

# Remove import and startup block from src/index.ts (added in Phase 2)

# Remove env vars from .env
# Delete lines: A2A_PORT, A2A_WEB_TOKEN

# Remove git remote
git remote remove nanoclaw-a2a

# Rebuild and restart
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Optionally remove a2a-mcp
rm -rf "<MCP_INSTALL_PATH>"
# Remove the mcpServers entry from your coding assistant's MCP config
```
