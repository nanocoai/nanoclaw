---
name: add-hindsight
description: Wire NanoClaw v2 agent groups to a running Hindsight memory backend. Builds the bundled hindsight-mcp wrapper, registers it as an additional mount, and wires it per-group via `ncl groups config`. Assumes a Hindsight engine is already running.
---

# Add Hindsight Memory

Wires NanoClaw agents to [Hindsight](https://github.com/vectorize-io/hindsight)
long-term memory. Each wired agent group gets its own bank with three MCP
tools — `memory_recall`, `memory_retain`, `memory_reflect`.

## Prerequisite — out of scope for this skill

This skill **does not deploy the Hindsight engine**. Bring it up first
following the upstream [Hindsight install
guide](https://github.com/vectorize-io/hindsight). The engine exposes an
HTTP API on a port of your choosing.

> ⚠️ **The URL must be reachable from inside agent containers, not just
> from the host.** Agent containers run on Docker's bridge network, so
> `http://localhost:3850` resolves to the *container's* loopback, not
> yours. Use one of:
>
> - `http://host.docker.internal:3850` — when the engine is published on
>   the host's loopback (works on Docker Desktop + Linux with
>   `--add-host host.docker.internal:host-gateway`, which NanoClaw sets).
> - A VPN/WireGuard IP that both host and containers can route to.
> - The engine's container hostname if it shares NanoClaw's bridge
>   network.
>
> Test from inside any running agent container with
> `docker exec <container> curl -fsS <your-url>/health` before wiring.

## Pre-flight — detect existing wiring

If you wired Hindsight some other way before this skill existed (or
you're re-running `/add-hindsight` after an earlier attempt), this
skill is **not idempotent against pre-existing entries** — adding a
second `containerPath: "hindsight-mcp"` mount will make container
spawn fail. Detect first:

```bash
# Run from the NanoClaw repo root. Uses scripts/q.ts (better-sqlite3
# wrapper) so this works without the sqlite3 CLI binary on the host.
pnpm exec tsx scripts/q.ts data/v2.db "
SELECT agent_group_id, 'mcp_server: hindsight'
FROM container_configs
WHERE json_extract(mcp_servers, '\$.hindsight') IS NOT NULL
UNION ALL
SELECT cc.agent_group_id, 'additional_mount: ' || json_extract(m.value, '\$.hostPath')
FROM container_configs cc, json_each(cc.additional_mounts) m
WHERE json_extract(m.value, '\$.containerPath') = 'hindsight-mcp';
"
```

- **Empty output** → no prior wiring, continue to Phase 1.
- **Rows present** → for each group id listed, run the [**Removal**](#removal)
  block below *before* doing Phase 3. (Phase 1 build + Phase 2
  allowlist add are still safe to run.)

## Phase 1 — Build the wrapper

The wrapper source ships under `hindsight-mcp/`. Build it locally — no
docker needed for the NanoClaw integration path (agent containers spawn
the wrapper as a stdio child process, not as a long-running service):

```bash
( cd hindsight-mcp && npm install && npm run build )
```

The subshell `( … )` keeps your cwd in the repo root for the next phases.

This produces `hindsight-mcp/dist/server-stdio.js` (the entry point the
agent will exec) and `hindsight-mcp/node_modules/` (its deps). Both stay
inside the repo — no extracting, no copying.

> **Aside — HTTP transport.** The bundled wrapper also has an HTTP
> transport (multi-tenant, Bearer-token auth) for sharing one wrapper
> across multiple NanoClaw installs or non-NanoClaw MCP clients. See
> `hindsight-mcp/README.md` for that path. NanoClaw agents do not need it.

## Phase 2 — Register the mount path

Agent containers must be allowed to mount `hindsight-mcp/` from the host.
Open `~/.config/nanoclaw/mount-allowlist.json` and add this entry to
`allowedRoots` (replace `<absolute-path-to-repo>` with your own — e.g.
`/home/alex/nanoclaw`):

```json
{
  "path": "<absolute-path-to-repo>/hindsight-mcp",
  "allowReadWrite": false,
  "description": "hindsight-mcp wrapper (dist + node_modules, read-only)"
}
```

The `/manage-mounts` skill does the edit interactively if you'd rather
not touch the file by hand.

Mount-allowlist is in-memory cached. Restart NanoClaw so the new entry
takes effect:

```bash
systemctl --user restart nanoclaw-v2-*.service   # Linux
# or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 3 — Wire each group that should have memory

Run from the **NanoClaw repo root** (so `data/v2.db` resolves). For each
agent group, run the commands below. Find the group id with
`ncl groups list`.

> The `ncl groups config ...` and `ncl groups restart` calls are
> approval-gated. When run from the host CLI they prompt you to
> confirm inline — just say yes.

```bash
# Inputs (edit these, then run the block)
GID=<group-id>
HINDSIGHT_URL=<engine-url-reachable-from-container>   # see Prerequisite warning
BANK_PREFIX=nanoclaw                                  # namespace for this install
HINDSIGHT_MCP_PATH="$(pwd)/hindsight-mcp"             # auto from cwd

# Strip scheme + path → host[:port] for the NO_PROXY value below.
ENGINE_HOST=$(echo "$HINDSIGHT_URL" | sed -E 's|^https?://([^/]+).*|\1|')

# 1. Add the MCP server entry. NO_PROXY tells Node 22's fetch to bypass
#    any http_proxy/HTTPS_PROXY env injected by NanoClaw's gateway for
#    the engine host — without it, Node CONNECT-tunnels plain HTTP and
#    the handshake fails with `fetch failed` / TLS errors in the gateway
#    log (`docker logs onecli-app-1`).
ncl groups config add-mcp-server \
  --id "$GID" \
  --name hindsight \
  --command node \
  --args '["/workspace/extra/hindsight-mcp/dist/server-stdio.js"]' \
  --env "$(jq -nc \
    --arg url "$HINDSIGHT_URL" \
    --arg pfx "$BANK_PREFIX" \
    --arg np "$ENGINE_HOST" \
    '{HINDSIGHT_URL:$url, HINDSIGHT_BANK_PREFIX:$pfx, NO_PROXY:$np, no_proxy:$np}')"

# 2. Add the additional_mount. `ncl groups config add-mount` does not exist
#    yet, so edit the DB row directly. Backup first — the schema change is
#    a 1-row UPDATE but a typo can shred the json column.
cp data/v2.db data/v2.db.bak-$(date +%s)

pnpm exec tsx scripts/q.ts data/v2.db "
UPDATE container_configs
SET additional_mounts = json_insert(
  COALESCE(additional_mounts, '[]'),
  '\$[#]',
  json_object(
    'hostPath', '$HINDSIGHT_MCP_PATH',
    'containerPath', 'hindsight-mcp',
    'readonly', json('true')
  )
)
WHERE agent_group_id = '$GID';
"

# 3. Restart so the new config + mount take effect
ncl groups restart --id "$GID"
```

## Phase 4 — Verify

Send the wired group's agent this concrete test prompt:

> Please call `memory_retain` with `group="<this-group's-folder>"`,
> `content="hindsight wiring verified on YYYY-MM-DD"`, and
> `context="add-hindsight smoke-test"`. After it succeeds, call
> `memory_recall` with the same `group` and `query="hindsight wiring"`
> and tell me what comes back.

The agent should:
1. Call `mcp__hindsight__memory_retain` — get a success result.
2. Call `mcp__hindsight__memory_recall` — get at least one hit, the
   one it just retained.
3. Quote the retained memory back to you.

If any of those steps silently no-op, check logs:

```bash
tail -100 logs/nanoclaw.log | grep -iE 'hindsight|mcp'
# Also: container logs for the most recent session
docker logs $(docker ps --filter 'name=nanoclaw-' --format '{{.Names}}' | head -1) 2>&1 | tail -50
```

Common signals: `ENOENT server-stdio.js` → mount didn't apply (restart
NanoClaw + the group container, double-check Phase 2). `ECONNREFUSED`
→ `HINDSIGHT_URL` not container-reachable (re-read the Prerequisite).
First call always takes 1-2 seconds while the stdio MCP server spawns.

## Phase 5 — Discipline (automatic)

The wired agent automatically loads `container/skills/hindsight/SKILL.md`
on first turn — that file teaches the agent *when* to recall, *when* to
retain, what NOT to retain, and the common anti-patterns. **Don't skip
it** — agents without that discipline over-retain or hallucinate "saved".

## Removal

Run from the **NanoClaw repo root**:

```bash
GID=<group-id>

ncl groups config remove-mcp-server --id "$GID" --name hindsight

cp data/v2.db data/v2.db.bak-$(date +%s)
pnpm exec tsx scripts/q.ts data/v2.db "
UPDATE container_configs SET additional_mounts = (
  SELECT json_group_array(value) FROM json_each(additional_mounts)
  WHERE json_extract(value, '\$.containerPath') != 'hindsight-mcp'
)
WHERE agent_group_id = '$GID';
"

ncl groups restart --id "$GID"
```

Optionally remove the mount-allowlist entry via `/manage-mounts` if no
other tooling needs the `hindsight-mcp/` path.

## Credits & references

- **Hindsight engine**: [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
  (Apache 2.0). Graph-extracting memory with semantic search.
- **Bundled wrapper**: `hindsight-mcp/` in this repo. MIT.
- **Sibling skill**: `/add-mnemon` ships a graph-based memory alternative.
  Pick one — running both is redundant.
