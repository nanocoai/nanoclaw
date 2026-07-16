---
name: add-local-llama
description: Wire a NanoClaw agent group to a local/LAN OpenAI-compatible endpoint via the OpenCode provider. Supports two modes — direct to a bare llama.cpp/vLLM server (no auth), or routed through a LiteLLM proxy (virtual key + model zoo). Assumes /add-opencode has already run.
---

# add-local-llama

Route a NanoClaw agent group at an OpenAI-compatible endpoint on the
LAN via the OpenCode provider. Two supported modes, pick whichever
fits:

- **Direct mode** — point OpenCode at a single bare llama.cpp / vLLM
  server, no auth. Simple. One agent ↔ one model. Swap models by
  restarting llama.cpp with a different GGUF.
- **LiteLLM mode** — point OpenCode at a LiteLLM proxy that fronts
  multiple backends (local or cloud). Swap between models by changing
  one env string (`OPENCODE_MODEL`) — no NanoClaw restart needed.
  LiteLLM also gives you virtual keys, spend tracking, and logging.

Both modes rely on the same three env-gated customizations to the
OpenCode provider (commit:
`feat(opencode-provider): support custom provider npm, no-auth, + env-supplied API key`):

- `OPENCODE_PROVIDER_NPM` — names the Vercel AI SDK package
  (`@ai-sdk/openai-compatible`) OpenCode should load.
- `OPENCODE_PROVIDER_NO_AUTH=1` — skip the placeholder Authorization
  header (direct-mode only, for servers that ignore auth).
- `OPENCODE_PROVIDER_API_KEY` — send a real key as the Authorization
  bearer (LiteLLM mode or any keyed endpoint not behind OneCLI).

## Prereqs

- `/add-opencode` done. `docker run --rm --entrypoint opencode <image> --version`
  should print 1.4.x.
- Target agent group exists — create via `/manage-channels` or
  `setup/index.ts --step register` first.

## Run

### 1. Identify the group

```bash
node -e "
const db = require('better-sqlite3')('data/v2.db', {readonly: true});
console.log(db.prepare(\"SELECT id, name, folder, agent_provider FROM agent_groups\").all());
"
```

Pick the `folder` for the group you want to wire (e.g. `codex-local-llm`).

### 2. Flip agent_provider + clear stale sessions

```bash
FOLDER="codex-local-llm"   # ← replace with your folder
node -e "
const db = require('better-sqlite3')('data/v2.db');
const r = db.prepare(\"UPDATE agent_groups SET agent_provider='opencode' WHERE folder=?\").run(process.env.FOLDER);
console.log('agent_groups:', r.changes);
const s = db.prepare(\"UPDATE sessions SET agent_provider=NULL WHERE agent_group_id=(SELECT id FROM agent_groups WHERE folder=?)\").run(process.env.FOLDER);
console.log('sessions cleared:', s.changes);
" FOLDER="$FOLDER"

# Wipe any prior Codex/Claude session state and OpenCode XDG to force
# a fresh session on first message. Harmless if nothing exists yet.
GID=$(node -e "const db=require('better-sqlite3')('data/v2.db',{readonly:true}); console.log(db.prepare('SELECT id FROM agent_groups WHERE folder=?').get(process.env.FOLDER).id)" FOLDER="$FOLDER")
for sess in "data/v2-sessions/$GID"/sess-*; do
  [ -d "$sess" ] || continue
  node -e "
const db = require('better-sqlite3')('$sess/outbound.db');
db.prepare(\"DELETE FROM session_state WHERE key='sdk_session_id'\").run();
"
  rm -rf "$sess/opencode-xdg" 2>/dev/null || true
done
```

### 3a. Direct-to-llama.cpp mode

Replace `BASE_URL` and `MODEL_ID`.

```bash
FOLDER="codex-local-llm"
BASE_URL="http://192.168.1.95:8080/v1"
MODEL_ID="glm-4.7-flash"
LAN_HOST=$(echo "$BASE_URL" | sed -E 's|^https?://([^:/]+).*|\1|')

cat > "groups/$FOLDER/container.json" <<EOF
{
  "mcpServers": {},
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": "all",
  "provider": "opencode",
  "env": {
    "OPENCODE_PROVIDER": "local-llama",
    "OPENCODE_PROVIDER_NPM": "@ai-sdk/openai-compatible",
    "OPENCODE_PROVIDER_NO_AUTH": "1",
    "OPENCODE_MODEL": "local-llama/$MODEL_ID",
    "OPENCODE_SMALL_MODEL": "local-llama/$MODEL_ID",
    "ANTHROPIC_BASE_URL": "$BASE_URL",
    "NO_PROXY": "127.0.0.1,localhost,$LAN_HOST",
    "no_proxy": "127.0.0.1,localhost,$LAN_HOST"
  }
}
EOF
```

### 3b. LiteLLM-in-front mode (recommended for multi-model use)

Spin up a LiteLLM virtual key scoped to the models you want the
agent to access:

```bash
curl -sS -H "Authorization: Bearer YOUR_LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"models":["glm-4.7-flash","llama-3.3-70b"],"key_alias":"nanoclaw-localllm"}' \
  http://192.168.1.95:4000/key/generate
```

Copy the returned `key` into the block below. Then:

```bash
FOLDER="codex-local-llm"
LITELLM_URL="http://192.168.1.95:4000/v1"
LITELLM_KEY="sk-REPLACE_WITH_VIRTUAL_KEY"
MODEL_ID="glm-4.7-flash"
LAN_HOST=$(echo "$LITELLM_URL" | sed -E 's|^https?://([^:/]+).*|\1|')

cat > "groups/$FOLDER/container.json" <<EOF
{
  "mcpServers": {},
  "packages": { "apt": [], "npm": [] },
  "additionalMounts": [],
  "skills": "all",
  "provider": "opencode",
  "env": {
    "OPENCODE_PROVIDER": "litellm",
    "OPENCODE_PROVIDER_NPM": "@ai-sdk/openai-compatible",
    "OPENCODE_PROVIDER_API_KEY": "$LITELLM_KEY",
    "OPENCODE_MODEL": "litellm/$MODEL_ID",
    "OPENCODE_SMALL_MODEL": "litellm/$MODEL_ID",
    "ANTHROPIC_BASE_URL": "$LITELLM_URL",
    "NO_PROXY": "127.0.0.1,localhost,$LAN_HOST",
    "no_proxy": "127.0.0.1,localhost,$LAN_HOST"
  }
}
EOF
```

To swap models later, just change `OPENCODE_MODEL` (and ideally
`OPENCODE_SMALL_MODEL` to match) to another model LiteLLM exposes —
e.g. `litellm/llama-3.3-70b`. Cycle the container and the next
message uses it.

The host will stamp `groupName` / `assistantName` / `agentGroupId`
back into the file on the next session resolve. The `env` block
survives that rewrite as of the `container_config.env` passthrough
patch on `src/container-config.ts`.

### 4. Cycle the container if one is running

```bash
NAME=$(docker ps --filter "name=nanoclaw-v2-${FOLDER}" --format '{{.Names}}' | head -1)
[ -n "$NAME" ] && docker stop "$NAME"
```

Next message to the group's channel spawns a fresh container that
reads the new `provider` + `env`.

### 5. Verify

Send a test message in the wired channel. The container log should
show:

```
[agent-runner] Starting v2 agent-runner (provider: opencode)
```

For direct mode: llama.cpp's log shows a `POST /v1/chat/completions`
hit from the container's IP. For LiteLLM mode: LiteLLM's log shows the
same and resolves to the model backend.

If the container starts but gets no response:

- `docker exec $NAME printenv OPENCODE_PROVIDER OPENCODE_MODEL ANTHROPIC_BASE_URL`
  should show all three set correctly.
- `docker exec $NAME curl -sS "$ANTHROPIC_BASE_URL/models"` should list
  the model ids.
- For LiteLLM: check that `OPENCODE_PROVIDER_API_KEY` is the virtual
  key, not the master key, and that the virtual key has the target
  model in its allow-list.
- For direct mode: if the server requires auth, unset
  `OPENCODE_PROVIDER_NO_AUTH` and set `OPENCODE_PROVIDER_API_KEY`
  instead.

## Undo

Swap the agent group back to its previous provider:

```bash
FOLDER="codex-local-llm"
node -e "
const db = require('better-sqlite3')('data/v2.db');
db.prepare(\"UPDATE agent_groups SET agent_provider='codex' WHERE folder=?\").run(process.env.FOLDER);
" FOLDER="$FOLDER"
# Then edit container.json to restore provider: "codex" and the old env block.
```

## Notes on durability

This skill + the `OPENCODE_PROVIDER_NPM` / `_NO_AUTH` / `_API_KEY`
patch on `opencode.ts` are the only places NanoClaw knows about your
custom endpoint — both survive upstream updates cleanly:

- The skill lives under `.claude/skills/` which upstream doesn't
  touch.
- The env-gated `OPENCODE_PROVIDER_*` patches are backwards-compatible
  additions; pending PR upstream so future `/add-opencode` re-runs
  don't clobber them.
