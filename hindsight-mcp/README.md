# hindsight-mcp

MCP server wrapping a running [Hindsight](https://github.com/vectorize-io/hindsight)
agent-memory engine. Exposes three generic tools — `memory_retain`,
`memory_recall`, `memory_reflect` — over both **HTTP** and **stdio**
transports, so any MCP client (Claude Code, Claude Desktop, an IDE
plugin, NanoClaw, …) can plug in.

```
  MCP client  ── MCP/HTTP or stdio ──>  hindsight-mcp  ── HTTP ──>  Hindsight engine
  (with token)                          (this repo)                (vectorize-io)
```

## Scope

This wrapper assumes a **Hindsight engine is already running**. It does
not deploy the engine itself. To set the engine up, follow the upstream
[Hindsight](https://github.com/vectorize-io/hindsight) install (it ships
its own docker-compose). Then point `HINDSIGHT_URL` here at it.

## Two install paths

- **NanoClaw integration (stdio, no docker):** if you only need this
  wrapper for NanoClaw agents, you do not need the HTTP transport or
  docker. Just `npm install && npm run build`, then follow
  [`../.claude/skills/add-hindsight/SKILL.md`](../.claude/skills/add-hindsight/SKILL.md).
  The agent containers spawn the stdio binary directly.
- **Standalone HTTP service (this README, below):** for sharing one
  wrapper across multiple MCP clients or across machines, run the
  multi-tenant HTTP transport via the bundled `docker-compose.yml`.

## Setup (HTTP transport)

```bash
cp .env.example .env
# Edit:
#   HINDSIGHT_URL          → where your engine is listening (HTTP)
#   MCP_AUTH_TOKENS        → at least one token:prefix pair (see below)

docker compose up -d
docker compose logs -f hindsight-mcp
```

Verify the wrapper:

```bash
# Health (no auth)
curl -fsS http://127.0.0.1:3852/health

# MCP tools/list (Bearer required)
curl -sS -X POST http://127.0.0.1:3852/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer <your-token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Auth — multi-tenant by design

Every HTTP request must carry `Authorization: Bearer <token>`. Tokens
are mapped 1:1 to bank prefixes in `.env`:

```
MCP_AUTH_TOKENS=claudeai-q7xN…:claudeai,claudecode-FnFm…:claudecode
```

The prefix is prepended to whatever `group` value the caller passes,
forming the Hindsight `bank_id`. Two clients with the same `group`
argument but different tokens reach **different** banks — cross-client
leakage is prevented at the namespace level.

The **stdio** transport is single-tenant: the bank prefix comes from
`HINDSIGHT_BANK_PREFIX` (env var) at spawn time. Use stdio when the local
process boundary is the trust boundary (e.g. a per-agent stdio server
started by an MCP client).

## MCP tools

| Tool | Parameters | Notes |
|---|---|---|
| `memory_retain` | `group`, `content`, `context` (optional) | Stores a memory; triggers entity extraction in Hindsight. |
| `memory_recall` | `group`, `query`, `budget` (`low`/`mid`/`high`) | Semantic + graph recall, ranked. Cheap. |
| `memory_reflect` | `group`, `query`, `budget` | LLM-synthesised answer with the evidence used. More expensive. |

## Share memory across surfaces (NanoClaw + Claude Code + Claude Chat)

One running wrapper can back **all of your MCP-aware Claude surfaces**
against the same Hindsight engine. The bank-prefix model decides
who-sees-what:

```
HTTP-Bearer token X  →  prefix "andy"        →  bank "andy:<group>"
HTTP-Bearer token Y  →  prefix "claudecode"  →  bank "claudecode:<group>"
stdio (NanoClaw)     →  env prefix "nanoclaw" → bank "nanoclaw:<group-folder>"
```

Two clients pointing at **the same token + same `group`** read/write
the **same bank** — that's the cross-surface sharing knob.

### Recipes

**Andy-style: one shared brain across NanoClaw and Claude Chat.**
The NanoClaw agent and your mobile Claude Chat see each other's memories.

1. Run this wrapper publicly (HTTPS, see below).
2. Generate one token: `MCP_AUTH_TOKENS=<token>:shared`.
3. NanoClaw side: use stdio with `HINDSIGHT_BANK_PREFIX=shared`
   (see `../.claude/skills/add-hindsight/SKILL.md`).
4. Claude Chat side: add the wrapper as a Custom Connector with the
   same token. When the agent and you both pass `group="<some-name>"`,
   you land in the same `shared:<some-name>` bank.

**Isolated brains across surfaces.**
Different tokens / different prefixes — surfaces never see each other.
Useful when one surface is private work, another is personal notes.

### Public-endpoint requirements

For Claude Chat (web/mobile) and Claude Desktop **remote** connectors
the wrapper has to be reachable from the internet:

- HTTPS terminating on a domain you control (Let's Encrypt via
  Caddy/Traefik/nginx is the standard).
- The MCP endpoint path is `/mcp` — terminate TLS in front, proxy
  plain HTTP to `127.0.0.1:3852` (`MCP_HOST_BIND=127.0.0.1`).
- Claude.ai's connector flow currently expects **OAuth 2.1** (not raw
  Bearer). To plug a Bearer-only wrapper in, either (a) put an OAuth
  proxy in front, or (b) use Claude Desktop's connector — it accepts
  Bearer-token MCP servers directly.
- Claude Code accepts either Bearer-token HTTP MCP or local stdio.
  Stdio is simpler when the binary is on the same machine; HTTP is
  preferable when you want shared state across machines.

### Bank-prefix discipline

The prefix is **stable per token, forever**. Changing a prefix
orphans every memory the old prefix wrote — they still exist in the
engine but the wrapper won't surface them anymore. Pick prefixes
deliberately at the start.

The `group` argument is per-call. Use the same `group` from any client
sharing the prefix and you'll converge on the same bank.

## Integration: NanoClaw

If you're wiring this into NanoClaw agents, **don't** invoke this README
directly — run `/add-hindsight` from your NanoClaw install. That skill
covers the per-agent wiring: stdio MCP server entry, `ncl groups config
add-mcp-server`, the in-container discipline skill, and the mount setup.
The skill assumes this wrapper is already running (you start it with
the steps above first).

## Development

```bash
npm install
npm run dev          # HTTP transport, tsx watch
npm run dev:stdio    # stdio transport, tsx watch
npm run build        # tsc to dist/
```

## License

MIT — see [LICENSE](LICENSE).
