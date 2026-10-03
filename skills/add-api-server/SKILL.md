---
name: add-api-server
description: Expose your NanoClaw agent as an OpenAI-compatible HTTP API with per-conversation session persistence, Bearer auth, and concurrent-safe request handling. Any tool that speaks OpenAI format can talk to your agent via /v1/chat/completions.
version: 2.0.0
author: robbyczgw-cla
---

# /add-api-server — OpenAI-Compatible API Server

Expose this NanoClaw agent as an OpenAI-compatible HTTP endpoint so external tools can send chat requests to it. v2 adds **session persistence**, **Bearer auth**, **concurrent-safety**, and **explicit tool allowlisting** — the features you actually need the moment you wire this into a real chat integration.

## When to Use

- User asks to add an API server or HTTP endpoint
- User wants external tools to talk to this agent via HTTP
- User wants to expose the agent as a model provider on the local network
- User wants per-topic / per-thread / per-user conversations that remember context across messages

## What It Does

Creates a Node.js HTTP server that:
- Listens on a configurable port (default: 8643)
- Accepts `POST /v1/chat/completions` in OpenAI format
- **Routes each conversation to its own Claude session** (`claude --session-id` / `--resume`) so context persists across messages
- Returns responses in OpenAI-compatible JSON
- Enforces **Bearer token authentication** when `NANOCLAW_API_TOKEN` env var is set
- Serializes concurrent requests for the same `conversation_id` (no session corruption)
- Uses `--allowedTools` rather than `--dangerously-skip-permissions` so it runs safely even as root (systemd-friendly)
- Offers `/v1/models`, `/v1/sessions` (list), `DELETE /v1/sessions/:id`, `/health`

## Pre-flight

1. Check if an API server is already running:

```bash
curl -s --noproxy '*' http://127.0.0.1:8643/health 2>/dev/null && echo "ALREADY RUNNING" || echo "NOT RUNNING"
```

If already running, ask the user whether to reconfigure or just verify.

2. Verify `claude` CLI is available and note the absolute path:

```bash
which claude || echo "MISSING"
# Use the absolute path (e.g. /usr/bin/claude) in the spawn call — not just "claude"
```

3. Note that `--dangerously-skip-permissions` is blocked when running as root. v2 sidesteps this with `--allowedTools`.

## Setup Procedure

### Step 1: Choose configuration

Ask the user:
- **Port** (default: 8643)
- **Auth token** — generate one if unset (`openssl rand -hex 24`). Store in env var `NANOCLAW_API_TOKEN`. If left empty, auth is disabled (local-only mode).
- **System prompt** (optional; written to `system-prompt.txt`)
- **Allowed tools** (default: `Bash Read Write Edit Grep Glob WebFetch WebSearch`) — space-separated list passed to `--allowedTools`
- **Working directory** for the server + sessions.json (default: `/root/api-server`)

### Step 2: Create the server files

```bash
mkdir -p /root/api-server
```

Optionally write `/root/api-server/system-prompt.txt` with the agent's persona.

Write `/root/api-server/server.js`:

```javascript
const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 8643;
const SYSTEM_PROMPT_FILE = path.join(__dirname, 'system-prompt.txt');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const AUTH_TOKEN = process.env.NANOCLAW_API_TOKEN || null; // null = auth disabled

// ---------- session store ----------
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSessions(store) {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2)); }
  catch (e) { console.error('sessions.json write failed:', e.message); }
}
// { conversationId: { sessionId: uuid, createdAt, lastUsedAt, count } }
let sessions = loadSessions();

// ---------- per-conversation serialization ----------
// Map<conversationId, Promise> — chains calls so 2nd waits for 1st
const convQueues = new Map();

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getOrCreateSession(conversationId) {
  if (!conversationId) return null;
  if (sessions[conversationId]) {
    sessions[conversationId].lastUsedAt = new Date().toISOString();
    sessions[conversationId].count = (sessions[conversationId].count || 0) + 1;
    saveSessions(sessions);
    return { sessionId: sessions[conversationId].sessionId, isNew: false };
  }
  const sessionId = crypto.randomUUID();
  sessions[conversationId] = {
    sessionId,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    count: 1
  };
  saveSessions(sessions);
  return { sessionId, isNew: true };
}

function runClaude(prompt, sessionInfo) {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'text',
      '--system-prompt-file', SYSTEM_PROMPT_FILE,
      '--allowedTools', 'Bash Read Write Edit Grep Glob WebFetch WebSearch'
    ];
    if (sessionInfo) {
      if (sessionInfo.isNew) args.push('--session-id', sessionInfo.sessionId);
      else args.push('--resume', sessionInfo.sessionId);
    }

    let output = '';
    let error = '';

    const proc = spawn('/usr/bin/claude', args, {
      env: { ...process.env, PATH: `/usr/bin:/usr/local/bin:${process.env.PATH || ''}` },
      cwd: __dirname,
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => error += d.toString());

    proc.on('close', code => {
      if (code !== 0 && !output) {
        return resolve({ ok: false, code, error: error.slice(0, 400) });
      }
      resolve({ ok: true, text: output.trim() });
    });

    proc.on('error', err => {
      resolve({ ok: false, code: -1, error: err.message });
    });
  });
}

async function handleChatCompletions(body, res) {
  const messages = body.messages || [];
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  if (!lastUserMsg) {
    return sendJSON(res, 400, { error: 'No user message found' });
  }

  const conversationId = body.conversation_id || body.user || null;

  const sessionInfo = getOrCreateSession(conversationId);
  let prompt;
  if (sessionInfo && !sessionInfo.isNew) {
    // Claude already has history via --resume
    prompt = lastUserMsg.content;
  } else if (messages.length > 1) {
    const history = messages.slice(0, -1)
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n');
    prompt = `Previous conversation:\n${history}\n\nCurrent message: ${lastUserMsg.content}`;
  } else {
    prompt = lastUserMsg.content;
  }

  // Serialize per-conversation
  const run = async () => runClaude(prompt, sessionInfo);
  let result;
  if (conversationId) {
    const prev = convQueues.get(conversationId) || Promise.resolve();
    const next = prev.then(run, run);
    convQueues.set(conversationId, next.catch(() => {}));
    result = await next;
  } else {
    result = await run();
  }

  if (!result.ok) {
    console.error(`claude failed: code=${result.code} err=${result.error}`);
    return sendJSON(res, 500, { error: 'Claude process failed', detail: result.error });
  }

  const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
  sendJSON(res, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'nanoclaw-agent',
    conversation_id: conversationId || undefined,
    session_id: sessionInfo ? sessionInfo.sessionId : undefined,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.text },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  });
}

function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token === AUTH_TOKEN;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Health/root — no auth required
  if (req.url === '/health' || req.url === '/') {
    return sendJSON(res, 200, {
      status: 'ok',
      agent: 'nanoclaw',
      port: PORT,
      auth: AUTH_TOKEN ? 'required' : 'disabled',
      sessions_tracked: Object.keys(sessions).length
    });
  }

  // Auth gate
  if (!checkAuth(req)) {
    return sendJSON(res, 401, { error: 'Unauthorized — missing or invalid Bearer token' });
  }

  if (req.url === '/v1/models' && req.method === 'GET') {
    return sendJSON(res, 200, {
      object: 'list',
      data: [{ id: 'nanoclaw-agent', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'nanoclaw' }]
    });
  }

  if (req.url === '/v1/sessions' && req.method === 'GET') {
    return sendJSON(res, 200, { sessions });
  }

  if (req.url.startsWith('/v1/sessions/') && req.method === 'DELETE') {
    const convId = decodeURIComponent(req.url.slice('/v1/sessions/'.length));
    if (sessions[convId]) {
      delete sessions[convId];
      saveSessions(sessions);
      return sendJSON(res, 200, { deleted: convId });
    }
    return sendJSON(res, 404, { error: 'Session not found' });
  }

  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { handleChatCompletions(JSON.parse(body), res).catch(e => sendJSON(res, 500, { error: 'handler crashed', detail: e.message })); }
      catch (e) { sendJSON(res, 400, { error: 'Invalid JSON', detail: e.message }); }
    });
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NanoClaw API Server on http://0.0.0.0:${PORT}`);
  console.log(`   Chat:     POST   /v1/chat/completions   (body: messages, conversation_id?)`);
  console.log(`   Models:   GET    /v1/models`);
  console.log(`   Sessions: GET    /v1/sessions   DELETE /v1/sessions/:id`);
  console.log(`   Auth:     ${AUTH_TOKEN ? 'enabled (Bearer)' : 'DISABLED — set NANOCLAW_API_TOKEN env to enable'}`);
});
```

### Step 3: Run under systemd (recommended)

Create a systemd unit so the server survives reboots and restarts on crash.

`/etc/systemd/system/nanoclaw-api-server.service`:

```ini
[Unit]
Description=NanoClaw OpenAI-compatible API Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/api-server
ExecStart=/usr/bin/node /root/api-server/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Add the auth token via a drop-in (keeps the token out of the main unit):

```bash
mkdir -p /etc/systemd/system/nanoclaw-api-server.service.d
cat > /etc/systemd/system/nanoclaw-api-server.service.d/override.conf <<EOF
[Service]
Environment=NANOCLAW_API_TOKEN=$(openssl rand -hex 24)
EOF

systemctl daemon-reload
systemctl enable --now nanoclaw-api-server.service
systemctl status nanoclaw-api-server.service
```

### Step 4: Verify

```bash
# Health (no auth required)
curl -s --noproxy '*' http://127.0.0.1:8643/health | jq

# Fetch the token you just generated
TOKEN=$(systemctl cat nanoclaw-api-server.service | grep NANOCLAW_API_TOKEN | cut -d= -f2)

# Models (auth required)
curl -s --noproxy '*' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8643/v1/models | jq

# First message in a new conversation
curl -s --noproxy '*' -X POST http://127.0.0.1:8643/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"nanoclaw-agent","conversation_id":"demo-1","messages":[{"role":"user","content":"Remember the number 1337."}]}' | jq

# Second message — should remember
curl -s --noproxy '*' -X POST http://127.0.0.1:8643/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"nanoclaw-agent","conversation_id":"demo-1","messages":[{"role":"user","content":"What number did I just give you?"}]}' | jq

# List active conversations
curl -s --noproxy '*' -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8643/v1/sessions | jq

# Reset a conversation
curl -s --noproxy '*' -X DELETE -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8643/v1/sessions/demo-1 | jq
```

## Usage Examples

### From curl — stateless call (no session)
```bash
curl -X POST http://YOUR_IP:8643/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"nanoclaw-agent","messages":[{"role":"user","content":"What time is it?"}]}'
```

### From curl — stateful conversation
```bash
curl -X POST http://YOUR_IP:8643/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
        "model":"nanoclaw-agent",
        "conversation_id":"user-alice",
        "messages":[{"role":"user","content":"Hey remember my favorite color is green"}]
      }'
```

Subsequent calls with the same `conversation_id` resume the Claude session automatically.

### From Python (OpenAI SDK)
```python
from openai import OpenAI
client = OpenAI(base_url="http://YOUR_IP:8643/v1", api_key="YOUR_TOKEN")

# conversation_id is passed via the `user` field (OpenAI-compat fallback)
# OR via extra_body={"conversation_id": "..."}
response = client.chat.completions.create(
    model="nanoclaw-agent",
    messages=[{"role": "user", "content": "Hey!"}],
    user="user-alice",
)
print(response.choices[0].message.content)
```

## Session Management

- **State file**: `/root/api-server/sessions.json` — JSON map of `{conversationId: {sessionId, createdAt, lastUsedAt, count}}`
- **Underlying Claude sessions**: stored by Claude CLI at `/root/.claude/projects/<cwd-slug>/<uuid>.jsonl`
- **List**: `GET /v1/sessions`
- **Delete** (reset memory for a conversation): `DELETE /v1/sessions/:conversationId`
- **Concurrent-safety**: requests with the same `conversation_id` are serialized via a Promise chain — parallel requests wait their turn, preventing session-file corruption

## Pitfalls

- **Proxy inside Docker**: `curl` may route through a container proxy. Use `--noproxy '*'` for localhost testing
- **Claude CLI auth**: `claude -p` uses OAuth. If auth expires, the server returns 500 with the error detail in the response
- **Running as root + `--dangerously-skip-permissions`**: the flag is blocked when the parent process is root. v2 uses `--allowedTools` instead, which works in all contexts (including systemd units running as root)
- **Absolute claude path**: `spawn('claude', ...)` inside a sandboxed systemd unit often fails with ENOENT. Use `/usr/bin/claude` (or whatever `which claude` returns) explicitly
- **stdin warning**: if you see "no stdin data received in 3s", ensure `stdio: ['ignore', 'pipe', 'pipe']` is set so Claude doesn't wait on stdin
- **Port conflicts**: check `ss -tlnp | grep 8643` before starting
- **Session growth**: `sessions.json` grows forever. Prune old entries (by `lastUsedAt`) periodically or add a TTL if you have many short-lived conversations

## Removal

```bash
systemctl disable --now nanoclaw-api-server.service
rm /etc/systemd/system/nanoclaw-api-server.service
rm -rf /etc/systemd/system/nanoclaw-api-server.service.d
systemctl daemon-reload
rm -rf /root/api-server
```

## Changelog

### v2.0.0
- Added per-conversation session persistence (`conversation_id` → `claude --session-id` / `--resume`)
- Added Bearer token auth via `NANOCLAW_API_TOKEN` env var (disabled by default for backwards compat)
- Added concurrent-safety: requests with the same `conversation_id` are serialized
- Replaced `--dangerously-skip-permissions` with explicit `--allowedTools` (root-safe, systemd-friendly)
- Added `GET /v1/sessions` and `DELETE /v1/sessions/:id` for inspection and reset
- Added absolute path to `claude` binary to fix ENOENT in systemd units
- Added explicit `stdio: ['ignore', 'pipe', 'pipe']` to silence stdin warnings
- Added systemd unit + drop-in example as recommended deployment

### v1.0.0
- Initial release: basic OpenAI-compatible HTTP endpoint, optional single-key auth, stateless per-request Claude spawn
