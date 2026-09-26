---
name: add-mem0-graph
description: Add persistent graph-enhanced memory using mem0 with existing Qdrant + Neo4j infrastructure and local BGE-M3 embeddings
---

# Add Graph-Enhanced Memory (mem0 + Qdrant + Neo4j)

Gives container agents persistent memory that survives across sessions and conversations. Uses the mem0 library against EXISTING Qdrant (vector search) and Neo4j (graph relationships) infrastructure -- no new Docker stack required. Local BGE-M3 embeddings provide multilingual support (German conversations work natively) at zero API cost with 1024 dimensions. Entity extraction and conflict resolution are handled automatically by a local LLM. On the host level, memory context is recalled before each agent invocation (pre-invocation recall) and new facts are captured after each successful conversation (post-conversation capture). Inside containers, agents have access to 7 MCP tools for explicit memory operations: save, search, update, remove, forget-session, forget-timerange, and history.

## Architecture Decisions

### Why mem0 instead of custom implementation?

mem0 (50k+ stars, Apache 2.0) solves entity extraction and conflict resolution out of the box. Building these from scratch would be 2-3x the effort for marginal benefit. mem0 supports Qdrant and Neo4j natively, which is a perfect fit for the existing infrastructure already running on this host.

### Why Qdrant + Neo4j instead of just one?

Qdrant is optimized for high-volume vector k-NN search (conversation chunks, episodes). Neo4j provides native graph traversal for relationship queries ("Who is connected to X?", "What does Klaus's dentist do?"). Combined, they enable semantic search and structured knowledge queries in parallel. The tradeoff is two systems to query instead of one, but parallel queries keep total latency under 100ms.

### Why a Python bridge instead of native TypeScript?

mem0 is Python-only -- no TypeScript port exists. The bridge is lightweight (~200 lines FastAPI) and runs as a systemd service. The alternative was loading Python in Node.js via child_process, which is more fragile and harder to debug. The tradeoff is an extra process, but HTTP gives clean decoupling: the bridge can be restarted independently, tested in isolation, and monitored with standard systemd tooling.

### Why local embeddings (BGE-M3) instead of OpenAI?

Zero API cost and no external dependency. BGE-M3 is multilingual, so German conversations work natively without translation. 1024 dimensions provide higher quality embeddings than all-MiniLM-L6-v2's 384 dimensions. The tradeoff is needing an embedding service running locally (Ollama, vLLM, or TEI), but this infrastructure is already present on the host.

### Why not MemOS (PR #1131)?

MemOS brings its OWN Neo4j + Qdrant stack, duplicating infrastructure that is already running. It also has 6 known bugs that need patching before it is production-ready. This skill reuses the existing infrastructure with zero new containers.

### Why not the existing /add-memory skill (PR #727)?

The existing /add-memory skill uses sqlite-vec (single-process, no graph support) and all-MiniLM-L6-v2 which is English-only with only 384 dimensions. It has no entity extraction or conflict resolution. This skill conflicts with /add-memory (declared in the manifest) because they both modify the same host-level hooks (pre-invocation recall and post-conversation capture).

### Forgetting strategy

- **Session-mode tagging:** Test and setup sessions are never captured into long-term memory.
- **Session-scoped deletion:** Forget entire conversations by run_id using `memory_forget_session`.
- **Time-range deletion:** Forget memories from a date range using `memory_forget_timerange`.
- **Noise filter:** Greetings, confirmations, and emoji-only messages are skipped during capture.
- **Provenance:** Every memory carries a run_id in the format `{group}:{session}:{mode}` for full traceability.

## Prerequisites

- Qdrant running (default: localhost:6333)
- Neo4j 5.x running (default: localhost:7687)
- An embedding model endpoint (BGE-M3 via Ollama, vLLM, or TEI)
- A chat-capable LLM endpoint for entity extraction (Ollama, vLLM)
- Python 3.11+
- Node.js 18+

## Phase 1: Pre-flight & Gather Info

Check that all prerequisites are reachable:

```bash
# Check Qdrant
curl -sf http://localhost:6333/collections | head -c 100 && echo " ✓ Qdrant" || echo "✗ Qdrant not reachable"

# Check Neo4j
curl -sf http://localhost:7474 | head -c 100 && echo " ✓ Neo4j" || echo "✗ Neo4j not reachable"

# Check Python
python3 --version && echo " ✓ Python" || echo "✗ Python not found"
```

If any prerequisite is not reachable, stop and tell the user what needs to be started or installed before continuing.

Then use AskUserQuestion to gather configuration values:

1. **Qdrant URL** (default: `http://localhost:6333`)
2. **Neo4j URL, user, password** (e.g., `bolt://localhost:7687`, `neo4j`, password)
3. **Embedding provider + model + URL** (e.g., `ollama` with `bge-m3` at `http://localhost:11434`, or `openai` compatible at a custom URL)
4. **LLM provider + model + URL** for entity extraction (e.g., `ollama` with `qwen2.5` at `http://localhost:11434`)
5. **User ID** for memory scoping (default: assistant name lowercased, e.g., `suki`)

After gathering inputs, validate the embedding endpoint with a test call:

```bash
# Example for Ollama
curl -sf http://localhost:11434/api/embeddings -d '{"model":"bge-m3","prompt":"test"}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'✓ Embedding OK, dims={len(d[\"embedding\"])}')" || echo "✗ Embedding endpoint not working"
```

If the embedding test fails, work with the user to fix the endpoint before proceeding.

## Phase 2: Install mem0-bridge

Set up the Python bridge service that wraps mem0's API:

```bash
cd services/mem0-bridge
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create the `.env` file from the gathered inputs:

```bash
cat > services/mem0-bridge/.env << 'ENVEOF'
MEM0_TELEMETRY=false
QDRANT_URL=http://localhost:6333
NEO4J_URL=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<gathered_password>
EMBED_PROVIDER=ollama
EMBED_MODEL=bge-m3
EMBED_URL=http://localhost:11434
EMBED_DIMS=1024
LLM_PROVIDER=ollama
LLM_MODEL=<gathered_model>
LLM_URL=http://localhost:11434
ENVEOF
```

Replace placeholder values with the actual values gathered in Phase 1.

Test the bridge starts correctly:

```bash
cd services/mem0-bridge
source venv/bin/activate
MEM0_TELEMETRY=false uvicorn app:app --host 127.0.0.1 --port 8095 &
sleep 3
curl -s http://localhost:8095/health | python3 -m json.tool
kill %1
```

The health endpoint should return a JSON object with status "ok". If it fails, check the uvicorn output for errors (usually missing dependencies or unreachable backends).

Install as a systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cp services/mem0-bridge/mem0-bridge.service ~/.config/systemd/user/mem0-bridge@.service
# Edit the service file if paths differ from the default
systemctl --user daemon-reload
systemctl --user enable mem0-bridge@$USER
systemctl --user start mem0-bridge@$USER
systemctl --user status mem0-bridge@$USER
```

Verify the service is running and healthy:

```bash
curl -s http://localhost:8095/health | python3 -m json.tool
```

## Phase 3: Apply Code Changes

First, confirm the baseline builds cleanly:

```bash
npm run build
```

If the build fails, fix the issue before proceeding.

The skill engine will apply these changes:

- **`src/mem0-memory.ts`** (new file): HTTP client for the mem0-bridge, with functions for `addMemory()`, `searchMemory()`, `updateMemory()`, `removeMemory()`, `forgetSession()`, `forgetTimerange()`, `getHistory()`, and host-level `retrieveMemoryContext()` / `captureConversation()`.
- **`src/config.ts`**: Adds `MEM0_BRIDGE_URL` and `MEM0_USER_ID` exports read from environment.
- **`src/index.ts`**: Adds `initMemory()` at startup to verify bridge connectivity, `retrieveMemoryContext()` before each agent invocation to inject relevant memories into the prompt, and `captureConversation()` after successful agent output to extract and store new facts.
- **`src/ipc.ts`**: Adds `memory/` IPC directory processing for container memory operations (request-response pattern for search, fire-and-forget for mutations).
- **`src/container-runner.ts`**: Creates the `memory/` IPC subdirectory inside each group's IPC directory.
- **`container/agent-runner/src/ipc-mcp-stdio.ts`**: Adds 7 MCP tools (`memory_save`, `memory_search`, `memory_update`, `memory_remove`, `memory_forget_session`, `memory_forget_timerange`, `memory_history`).

After changes are applied, verify the build:

```bash
npm run build
```

The build must be clean before proceeding. Fix any TypeScript errors.

## Phase 4: Container Rebuild

Rebuild the agent container so the new MCP tools are available inside containers:

```bash
./container/build.sh
```

If the build fails due to cache issues, prune the builder first:

```bash
docker builder prune -f
./container/build.sh
```

## Phase 5: Verify

Test the full memory round-trip through the bridge:

```bash
# Store a test memory
curl -s -X POST http://localhost:8095/add \
  -H 'Content-Type: application/json' \
  -d '{"messages": [{"role": "user", "content": "My dentist is Dr. Mueller, phone 089-123456"}], "user_id": "test", "run_id": "test:verify:live"}'

# Search for it
curl -s -X POST http://localhost:8095/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "dentist", "user_id": "test"}'
```

The search should return the stored memory about Dr. Mueller. If it returns empty results, check that the embedding endpoint is working and that the Qdrant collection was created.

Clean up test data:

```bash
curl -s -X POST http://localhost:8095/forget_session \
  -H 'Content-Type: application/json' \
  -d '{"run_id": "test:verify:live"}'
```

Restart NanoClaw to activate the host-level memory hooks:

```bash
systemctl --user restart nanoclaw
```

Check logs for successful memory initialization:

```bash
journalctl --user -u nanoclaw --since "1 min ago" | grep -i memory
```

You should see a log line indicating memory system initialized and bridge is reachable.

## Phase 6: CLAUDE.md Update

Add memory instructions to the group's `CLAUDE.md` so the agent knows about its memory capabilities. Include:

- Instructions to proactively save important facts, preferences, and contact details using `memory_save`.
- Instructions to use `memory_search` when the user asks about something that might have been discussed before.
- Instructions to respect user requests to forget information (using `memory_remove`, `memory_forget_session`, or `memory_forget_timerange`).
- A note that memory context is automatically injected into prompts -- the agent does not need to search for every conversation, only for explicit recall requests.

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `memory_save` | Save a fact or preference to long-term memory. Accepts a text string. Entity extraction happens automatically on the bridge side. |
| `memory_search` | Search past memories and conversations by semantic query. Returns ranked results with IDs, content, and relevance scores. |
| `memory_update` | Update an existing memory by ID. Use when a fact has changed (e.g., new phone number). |
| `memory_remove` | Remove a single memory by ID. Use when the user explicitly asks to forget something specific. |
| `memory_forget_session` | Forget all memories from an entire conversation/session by run_id. |
| `memory_forget_timerange` | Forget all memories from a date range. Accepts start and end ISO timestamps. |
| `memory_history` | View the change history for a specific memory by ID. Shows when it was created, updated, and what changed. |

## Troubleshooting

### Bridge not starting

Check the systemd service status and logs:

```bash
systemctl --user status mem0-bridge@$USER
journalctl --user -u mem0-bridge@$USER --since "5 min ago"
```

Common causes: Python venv not found (check `WorkingDirectory` in the service file), missing `.env` file, or a dependency import error.

### Empty search results

1. Verify the embedding endpoint is working: `curl -s http://localhost:11434/api/embeddings -d '{"model":"bge-m3","prompt":"test"}'`
2. Check that the Qdrant collection exists: `curl -s http://localhost:6333/collections`
3. Verify memories were actually stored: call the `/add` endpoint and check Qdrant directly.

### Entity extraction failing

The LLM endpoint must support JSON response format and be capable of following structured extraction prompts. Verify the LLM is reachable:

```bash
curl -s http://localhost:11434/api/generate -d '{"model":"<your_model>","prompt":"Say hello","stream":false}' | python3 -m json.tool
```

If entity extraction silently fails, memories are still stored as vector embeddings -- only the graph relationships in Neo4j will be missing.

### Neo4j auth error

Verify the credentials in `services/mem0-bridge/.env`:

```bash
cypher-shell -u neo4j -p '<password>' "RETURN 1"
```

Or test via HTTP:

```bash
curl -u neo4j:<password> http://localhost:7474/db/data/
```

### Memory not appearing in agent prompts

Check that `MEM0_BRIDGE_URL` is set in the NanoClaw `.env` file and that the bridge is reachable from the host process. Look for "Memory retrieval failed" warnings in the NanoClaw logs:

```bash
journalctl --user -u nanoclaw --since "10 min ago" | grep -i "memory"
```

The system gracefully degrades -- if memory retrieval fails, the agent still runs without injected context.

### High latency on memory operations

Qdrant and Neo4j are queried in parallel, so total latency should be under 100ms. If latency is high:

1. Check Qdrant performance: `curl -s http://localhost:6333/collections/<collection>/points/count`
2. Check Neo4j: `cypher-shell "CALL db.stats.retrieve('GRAPH COUNTS')"`
3. Large memory stores (>100k entries) may benefit from Qdrant index optimization.
