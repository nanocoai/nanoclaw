---
name: add-graphiti
description: Add Graphiti temporal knowledge-graph memory (Neo4j-backed, via the Graphiti MCP server) to selected NanoClaw agent groups. Agents search for relevant facts instead of loading every memory into context. Use when adding searchable long-term memory, a knowledge graph, or Graphiti/Zep-style memory.
---

# Add Graphiti — Knowledge-Graph Memory

Runs [Graphiti](https://github.com/getzep/graphiti)'s MCP server and a Neo4j
Community Edition database as a host-side Docker Compose stack, then registers
it as an MCP server named `graphiti` for each selected agent group.

Agents get temporal, searchable memory:

- **Entities** (people, projects, tools) with summaries that evolve.
- **Facts** (edges) with validity windows — a changed fact is invalidated, not
  deleted, so history is kept.
- **Episodes** — the raw text each entity and fact was extracted from.

Retrieval is hybrid (embeddings + BM25 + graph traversal) and needs no LLM at
query time, so only the matching facts enter the agent's context. Ingestion
(`add_memory`) does call an LLM to extract entities and facts; that LLM and the
embedder are configured on the Graphiti server, not on the agent.

The registration is provider-agnostic: any agent provider with MCP support
picks it up.

## What gets installed

| Where | What |
|-------|------|
| `container/cli-tools.json` | `mcp-remote` (pinned) — the stdio→HTTP bridge, used so destructive tools can be filtered out |
| `src/graphiti-manifest.test.ts` | Guard that the bridge stays in the image manifest |
| `data/graphiti/` (gitignored) | `docker-compose.yml`, `config.yaml`, `proxy.conf`, `.env` (0600) — the running stack |
| Docker | Compose project `nanoclaw-graphiti`: `neo4j:5.26.0`, `zepai/knowledge-graph-mcp:1.1.0-graphiti-0.30.1-standalone`, `nginx:1.30.4-alpine` (front door, see below); volumes `neo4j_data`, `neo4j_logs` |
| Per group | MCP server `graphiti` in the container config; a `graphiti-memory` block in `groups/<folder>/instructions.prepend.md` |

The agent never sees the LLM or Neo4j credentials: they live in
`data/graphiti/.env`, read only by the compose stack.

## Phase 1: Pre-flight

### Egress lockdown

```bash
grep -E '^NANOCLAW_EGRESS_LOCKDOWN=true' .env && echo "LOCKDOWN ON" || echo "lockdown off"
```

With lockdown on, agent containers sit on an internal network where
`host.docker.internal` is the OneCLI gateway, so the Graphiti server on the
host is unreachable. **Stop here** and tell the user this skill does not yet
support egress lockdown.

### Already applied?

```bash
grep -n '"mcp-remote"' container/cli-tools.json || true
test -f data/graphiti/docker-compose.yml && echo "stack files present"
docker compose -p nanoclaw-graphiti ps 2>/dev/null
ncl groups list
```

Every phase below is idempotent. If the stack is already running, skip to
Phase 4 for any additional groups.

### Choose the groups and the LLM provider

Ask the user:

1. **Which agent groups get Graphiti memory.** All selected groups share one
   Neo4j database, partitioned by `group_id`. The partition is enforced by
   the agent's standing instructions, not by the server — a group that
   ignores them could read another group's graph. Only put groups that are
   already allowed to see each other's data on one stack (see
   [Isolation](#isolation)).
2. **Which LLM provider extracts entities**, and which embedder. OpenAI for
   both is the simplest (one key). `anthropic` works for extraction but has
   no embedder, so pair it with `openai`, `gemini`, or `voyage` embeddings.

Ask the user to put the key(s) in the file themselves in Phase 3. Never ask
for a key in chat.

## Phase 2: Install the MCP bridge

Add this object to the top-level array in `container/cli-tools.json` when an
entry named `mcp-remote` is not already present (it may already be there from
`/add-tavily-tool` — reuse it):

```json
{
  "name": "mcp-remote",
  "version": "0.1.38"
}
```

Copy the guard and rebuild:

```bash
cp .claude/skills/add-graphiti/graphiti-manifest.test.ts src/graphiti-manifest.test.ts
./container/build.sh
pnpm exec vitest run src/graphiti-manifest.test.ts
```

## Phase 3: Start the Graphiti stack

### 1. Lay down the stack files

```bash
mkdir -p data/graphiti
cp .claude/skills/add-graphiti/docker-compose.yml data/graphiti/docker-compose.yml
cp .claude/skills/add-graphiti/config.yaml data/graphiti/config.yaml
cp .claude/skills/add-graphiti/proxy.conf data/graphiti/proxy.conf
test -f data/graphiti/.env || cp .claude/skills/add-graphiti/graphiti.env.example data/graphiti/.env
chmod 600 data/graphiti/.env
```

Never overwrite an existing `data/graphiti/.env` — it holds the Neo4j password
the data volume was initialised with.

`proxy.conf` configures the `graphiti-proxy` front door. Graphiti's MCP server
answers `421 Invalid Host header` to any `Host` other than `localhost` /
`127.0.0.1` (DNS-rebinding protection the MCP SDK switches on at construction
and Graphiti never turns off when it rebinds to `0.0.0.0`). Agents connect as
`host.docker.internal`, and a fetch client cannot override `Host`, so the proxy
rewrites it host-side. The Graphiti container itself publishes no port.

### 2. Generate the Neo4j password (first install only)

```bash
grep -q '^NEO4J_PASSWORD=__GENERATED__$' data/graphiti/.env && \
  sed -i.bak "s/^NEO4J_PASSWORD=__GENERATED__$/NEO4J_PASSWORD=$(openssl rand -hex 24)/" data/graphiti/.env && \
  rm -f data/graphiti/.env.bak
```

### 3. Set the bind address

The MCP server must listen where agent containers resolve
`host.docker.internal`, and nowhere wider.

- **Linux** — containers get `--add-host=host.docker.internal:host-gateway`,
  which is the `docker0` bridge address:

  ```bash
  BRIDGE_IP=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')
  echo "$BRIDGE_IP"   # typically 172.17.0.1
  sed -i.bak "s/^GRAPHITI_BIND_ADDR=.*/GRAPHITI_BIND_ADDR=$BRIDGE_IP/" data/graphiti/.env && rm -f data/graphiti/.env.bak
  ```

- **macOS (Docker Desktop)** — keep `GRAPHITI_BIND_ADDR=127.0.0.1`; Docker
  Desktop routes `host.docker.internal` to the host loopback.

If port 8000 is taken (`ss -ltn 'sport = :8000'` / `lsof -iTCP:8000 -sTCP:LISTEN`),
set `GRAPHITI_PORT` to a free port and use it in Phase 4.

### 4. Provider and key

Set `LLM_PROVIDER`, `MODEL_NAME`, `EMBEDDER_PROVIDER`, `EMBEDDER_MODEL` in
`data/graphiti/.env` to the user's choice. Then ask the user to open
`data/graphiti/.env` in their editor and paste the API key(s) themselves.
Confirm without printing the value:

```bash
grep -E '^(OPENAI|ANTHROPIC|GOOGLE|GROQ|VOYAGE)_API_KEY=.+' data/graphiti/.env | cut -d= -f1
```

### 5. Start

```bash
docker compose -p nanoclaw-graphiti -f data/graphiti/docker-compose.yml up -d
```

Neo4j takes ~30s to pass its healthcheck before the MCP server starts. Wait
for health (substitute the port if changed):

```bash
for i in $(seq 1 30); do
  curl -fs "http://$(grep ^GRAPHITI_BIND_ADDR= data/graphiti/.env | cut -d= -f2):8000/health" && break
  sleep 3
done
```

If it never answers: `docker compose -p nanoclaw-graphiti logs graphiti-mcp --tail 50`.

## Phase 4: Register Graphiti per group

`config add-mcp-server` and `groups restart` are approval-gated. From inside a
container they return `approval-pending` immediately; that is not an error.

For each selected `<group-id>` (substitute the port if changed):

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name graphiti \
  --command mcp-remote \
  --args '["http://host.docker.internal:8000/mcp","--transport","http-only","--allow-http","--ignore-tool","clear_graph","--ignore-tool","build_communities"]' \
  --env '{}'
```

- The path is `/mcp` with **no trailing slash**: `/mcp/` answers `307`, and
  the bridge cannot replay a request body across a redirect
  (`UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`).
- `--allow-http`: the stack speaks plain HTTP on the Docker bridge; traffic
  never leaves the host.
- `clear_graph` is filtered because it wipes graphs by `group_id` — one call
  with the wrong id destroys another group's memory. `build_communities` is
  filtered because it runs LLM summarisation over a whole graph (slow,
  costly). An operator can still run either against the server directly.

### Standing instructions

Each group's graph is keyed by its folder name. For each selected group,
substitute `{{GROUP_ID}}` in
[memory-instructions.md](memory-instructions.md) with the group's folder
(`ncl groups get --id <group-id>` shows it) and write the block into
`groups/<folder>/instructions.prepend.md`: replace an existing
`<!-- graphiti-memory:start -->` … `<!-- graphiti-memory:end -->` block in
place, append otherwise. Do not write into `groups/<folder>/CLAUDE.md`; it is
regenerated at spawn.

### Restart

```bash
ncl groups restart \
  --id <group-id> \
  --message "Graphiti memory is installed. Add one memory episode noting that Graphiti was set up today, wait a few seconds, then search your memory facts for 'Graphiti' and report what you find."
```

## Phase 5: Verify

```bash
ncl groups config get --id <group-id>     # one "graphiti" server, mcp-remote, both --ignore-tool pairs
grep -c 'graphiti-memory:start' groups/<folder>/instructions.prepend.md   # 1
docker compose -p nanoclaw-graphiti ps    # neo4j + graphiti-mcp healthy, graphiti-proxy up
```

The agent's reply to the restart message should show an
`mcp__graphiti__add_memory` call with `group_id` = its folder, followed by a
`mcp__graphiti__search_memory_facts` call that returns the fact. The operator
can inspect the graph in the Neo4j browser at `http://127.0.0.1:7474`
(user `neo4j`, password from `data/graphiti/.env`).

## Isolation

One stack = one trust domain. `group_id` is a partition key the agent passes
as a tool argument; the Graphiti MCP server has no per-connection scoping, so
it does not stop a group from naming another group's id. For groups that must
not see each other's memory, give each its own stack: copy `data/graphiti/`
to `data/graphiti-<folder>/`, set a distinct `GRAPHITI_PORT` and Neo4j ports
(`NEO4J_HTTP_PORT`, `NEO4J_BOLT_PORT`) in its `.env`, start it with
`-p nanoclaw-graphiti-<folder>`, and register that group against its port.

## Troubleshooting

- **`command not found: mcp-remote`** — rebuild the image (`./container/build.sh`), restart the group.
- **Connection refused from the agent** — `GRAPHITI_BIND_ADDR` does not match
  what containers resolve `host.docker.internal` to. On Linux it must be the
  bridge gateway IP (Phase 3.3), not `127.0.0.1`. Re-`up -d` after changing it.
- **`421 Invalid Host header`** — the group is registered against the
  Graphiti container directly instead of `graphiti-proxy`, or `proxy.conf` is
  missing from `data/graphiti/`. Re-copy it and re-`up -d`.
- **`UND_ERR_REQ_CONTENT_LENGTH_MISMATCH` / `fetch failed`** — the registered
  URL ends in `/mcp/`; re-register with `/mcp`.
- **`502 Bad Gateway`** — `graphiti-mcp` is still starting or crashed; check its logs.
- **`add_memory` succeeds but nothing is ever searchable** — extraction is
  failing on the server: `docker compose -p nanoclaw-graphiti logs graphiti-mcp`.
  Usually a missing/invalid key or an LLM 429; lower `SEMAPHORE_LIMIT`.
- **Neo4j auth failure after editing `.env`** — the password is fixed at the
  first start of the `neo4j_data` volume. Restore the original, or remove the
  volume (destroys all memory) and start again.
- **Agent never uses memory** — check the `graphiti-memory` block is in
  `instructions.prepend.md` and restart. A long-running session keeps its old
  context; `/clear` starts a clean one.

## Removal

See [REMOVE.md](REMOVE.md).

## References

- [Graphiti](https://github.com/getzep/graphiti) and its [MCP server](https://github.com/getzep/graphiti/tree/main/mcp_server)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956)
- [`mcp-remote`](https://github.com/geelen/mcp-remote)
