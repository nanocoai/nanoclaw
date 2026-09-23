---
name: add-acp-client-agent
description: Route a NanoClaw agent group to any external AI agent that speaks the ACP Client Protocol (agentclientprotocol.com) — a JSON-RPC 2.0 protocol over TCP or stdio. NanoClaw acts as the editor/client. Works with Groq (free), any AI coding agent, or a custom server. Supports bidirectional file access so the agent can read/write workspace files. No npm dependencies, no container rebuild needed.
---

# ACP Client Protocol Provider

Routes an agent group's conversations to any external AI agent that speaks the
[ACP Client Protocol](https://agentclientprotocol.com) — JSON-RPC 2.0 over
TCP or stdin/stdout. NanoClaw acts as the **editor/client**: it drives the
agent through `initialize → session/new → session/prompt` and collects
streaming `session/update` notifications.

The agent can also call back into NanoClaw via `fs/read_text_file` and
`fs/write_text_file` to read or write files in `/workspace`.

Two connection modes:
- **Subprocess**: NanoClaw spawns the agent as a child process (stdin/stdout)
- **TCP**: NanoClaw connects to a running agent server

No new npm dependencies. No container image rebuild required.

## Install

### Pre-flight

Skip to **Configuration** if all of these are already present:

- `src/providers/acp-client.ts`
- `container/agent-runner/src/providers/acp-client.ts`
- `import './acp-client.js';` in `src/providers/index.ts`
- `import './acp-client.js';` in `container/agent-runner/src/providers/index.ts`

All steps below are idempotent — safe to re-run.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the provider source files

```bash
git show origin/providers:src/providers/acp-client.ts \
  > src/providers/acp-client.ts

git show origin/providers:container/agent-runner/src/providers/acp-client.ts \
  > container/agent-runner/src/providers/acp-client.ts
```

### 3. Wire the self-registration imports

Append to `src/providers/index.ts` if the line is not already present:

```typescript
import './acp-client.js';
```

Append to `container/agent-runner/src/providers/index.ts` if not already present:

```typescript
import './acp-client.js';
```

### 4. Build the host

```bash
pnpm run build
```

No container rebuild needed — `container/agent-runner/src/` is bind-mounted
read-only into every container at spawn time.

### 5. Verify

```bash
grep -q "'./acp-client.js'" src/providers/index.ts \
  && echo "host barrel: OK" || echo "host barrel: MISSING"

grep -q "'./acp-client.js'" container/agent-runner/src/providers/index.ts \
  && echo "container barrel: OK" || echo "container barrel: MISSING"

pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit \
  && echo "container typecheck: OK"
```

## Configuration

### 1. Create the agent group folder

```bash
mkdir -p groups/<folder>
```

### 2. Create acp-client.json

**Subprocess mode** (NanoClaw spawns the agent — no server to manage):
```json
{ "command": ["python3", "/path/to/my-agent.py"] }
```

**TCP mode** (connect to a running agent server):
```json
{ "host": "host.docker.internal", "port": 7787 }
```

Per-group `acp-client.json` always wins over global env vars. Global fallback:
`ACP_CLIENT_CMD`, `ACP_CLIENT_HOST`, `ACP_CLIENT_PORT` in `.env`.

### 3. Create container.json

```json
{
  "mcpServers": {},
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": "all",
  "agentGroupId": "ag-GENERATED",
  "groupName": "My ACP Client Agent",
  "assistantName": "My ACP Client Agent",
  "provider": "acp-client"
}
```

Generate a unique `agentGroupId`:
```bash
node -e "console.log('ag-' + Date.now() + '-' + Math.random().toString(36).slice(2,8))"
```

### 4. Set the provider in the database

Run this from the **project root** (the directory containing `data/` and `node_modules/`):

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
db.prepare('UPDATE agent_groups SET agent_provider = ? WHERE folder = ?')
  .run('acp-client', 'YOUR-GROUP-FOLDER');
console.log('updated:', db.prepare(
  'SELECT folder, agent_provider FROM agent_groups WHERE folder = ?'
).get('YOUR-GROUP-FOLDER'));
"
```

### 5. Choose routing mode

**Ask the user two questions before continuing:**

1. *"Should this ACP agent be the primary agent for the channel (handles all messages), or share the channel with your existing Claude agent using a trigger prefix?"*
2. If sharing: *"What prefix should trigger it? (e.g. `acp:`, `agent:`, `code:`)"*

Then run the matching commands below.

**Option A — Trigger prefix** (share a channel with the main agent)

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
const ag = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get('YOUR-FOLDER');
db.prepare(\`INSERT INTO messaging_group_agents
  (id, messaging_group_id, agent_group_id, session_mode, priority,
   created_at, engage_mode, engage_pattern, sender_scope, ignored_message_policy)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`)
  .run('mga-' + Date.now(), 'YOUR-MESSAGING-GROUP-ID', ag.id,
       'per-thread', 20, new Date().toISOString(),
       'pattern', '^PREFIX:', 'all', 'drop');
console.log('wired trigger: ^PREFIX:');
"
```

Then exclude the prefix from the main agent's pattern:

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
const row = db.prepare(
  'SELECT id, engage_pattern FROM messaging_group_agents WHERE agent_group_id = ?'
).get('YOUR-MAIN-AGENT-GROUP-ID');
// Handle both: existing negative lookahead (append) or simple pattern (convert)
const updated = row.engage_pattern && row.engage_pattern.includes('(?!')
  ? row.engage_pattern.replace(/\\)$/, '|PREFIX:)')
  : '^(?!PREFIX:)';
db.prepare('UPDATE messaging_group_agents SET engage_mode = ?, engage_pattern = ? WHERE id = ?')
  .run('pattern', updated, row.id);
console.log('main agent pattern updated:', updated);
"
```

**Option B — Primary agent** (handles all messages in the channel)

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
const ag = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get('YOUR-FOLDER');
db.prepare(\`INSERT INTO messaging_group_agents
  (id, messaging_group_id, agent_group_id, session_mode, priority,
   created_at, engage_mode, engage_pattern, sender_scope, ignored_message_policy)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`)
  .run('mga-' + Date.now(), 'YOUR-MESSAGING-GROUP-ID', ag.id,
       'per-thread', 20, new Date().toISOString(),
       'always', null, 'all', 'drop');
console.log('wired as primary agent');
"
```

If an existing Claude agent is wired to this channel, it must be removed — the router fans out to ALL matching agents so both would reply. Ask the user to confirm, then delete its wiring:

```bash
node -e "
const db = require('./node_modules/better-sqlite3')('./data/v2.db');
db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?')
  .run('YOUR-MAIN-AGENT-GROUP-ID');
console.log('removed main agent wiring');
"
```

**Option C — Dedicated channel**
The user will use a separate channel exclusively for this agent. No wiring needed now — use Option B when the channel is ready.

## Troubleshooting

**"ACP_CLIENT_CMD or ACP_CLIENT_HOST+ACP_CLIENT_PORT required" in container logs**
The `acp-client.json` is missing or the database still has the old `agent_provider`.
Check step 2 (config file) and step 4 (DB update).

**"Failed to connect to ACP agent"**
In TCP mode: the agent server is not running or not reachable. Use
`host.docker.internal` (not `localhost`).
In subprocess mode: the command path is wrong or the script has a syntax error.

**No response / timeout**
The agent's `session/prompt` never returned a result.
Check the agent logs. In subprocess mode, check the process didn't exit early.

**"Path outside workspace" error**
The agent sent an `fs/` request for a path outside `/workspace`.
This is a security guard — the agent cannot escape the container boundary.
