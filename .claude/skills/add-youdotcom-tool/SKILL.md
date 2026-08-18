---
name: add-youdotcom-tool
description: Add You.com (YDC) web search, content extraction, research, and finance as remote MCP tools for selected NanoClaw agent groups. Starts keyless on the free tier and upgrades to the full toolset with an API key. Use when installing You.com web search, research, or finance without threading a key into the container.
---

# Add You.com Tool

Install the pinned `mcp-remote` bridge in the agent image and register You.com's
remote MCP server for each selected agent group. The MCP server supplies its
tool descriptions and input schemas at runtime.

By default the server is registered against You.com's **free tier**
(`https://api.you.com/mcp?profile=free`), which is keyless and exposes:

- `mcp__youdotcom__you-search` — web and news search (100 queries/day, shared)

The [upgrade path](#free-tier-limit) (Phase 5) stores a You.com API key in the
OneCLI vault and re-registers the server against the full endpoint, adding:

- `mcp__youdotcom__you-contents` — extract page content as markdown or HTML
- `mcp__youdotcom__you-research` — citation-backed synthesis (effort levels)
- `mcp__youdotcom__you-finance` — finance-optimized, citation-backed research
- `mcp__youdotcom__you-balance` — remaining API-key credit balance
- `mcp__youdotcom__you-discover` — You.com integration recommendations

Optionally, the same skill registers a second, keyless **Docs MCP** server for
searching You.com's own developer documentation:

- `mcp__youdotcom_docs__searchDocs` — search You.com docs, returns source URLs

The registration is provider-agnostic: any provider with MCP support picks it
up (Claude, OpenCode, and Codex all do). Groups on the Claude provider already
have the built-in `WebSearch` and `WebFetch` tools
(`container/agent-runner/src/providers/claude.ts`), so the skill adds the most
for groups on other providers, and for You.com's structured extraction,
research, and finance tools anywhere.

## Phase 1: Pre-flight

Check whether the bridge is already in the image manifest, then list the groups:

```bash
grep -n '"mcp-remote"' container/cli-tools.json || true
ncl groups list
```

Ask two questions:

1. Which agent groups should receive You.com.
2. Whether to also register the keyless **Docs MCP** server (`searchDocs`) for
   those groups. Default no — add it only for groups whose users build *with*
   You.com and want to search its documentation. Skip it otherwise.

If `mcp-remote` is already present at a pinned version, reuse the existing entry
instead of adding a second one.

## Phase 2: Install the MCP bridge

Add this object to the top-level array in `container/cli-tools.json` when an
entry named `mcp-remote` is not already present:

```json
{
  "name": "mcp-remote",
  "version": "0.1.38"
}
```

Keep the JSON valid and limit the entry to the two fields shown; this package
does not require a native build-script opt-in.

Copy the dependency guard into the host test tree:

```bash
cp .claude/skills/add-youdotcom-tool/youdotcom-manifest.test.ts src/youdotcom-manifest.test.ts
```

Build the image and run the guard:

```bash
./container/build.sh
pnpm exec vitest run src/youdotcom-manifest.test.ts
```

The manifest is the only source-backed integration point. Per-group MCP
registration is runtime state stored through `ncl`, so it has no in-tree line
for a registration test to guard — the Phase 4 smoke test verifies it instead.

## Phase 3: Register You.com

`config add-mcp-server` and `groups restart` are approval-gated. Run from
inside a container they return `approval-pending` immediately; that is not an
error. Wait for the admin's approval and the follow-up system message before
moving on to Phase 4.

For each selected `<group-id>`, register the keyless free-tier server named
`youdotcom`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name youdotcom \
  --command mcp-remote \
  --args '["https://api.you.com/mcp?profile=free","--transport","http-only","--enable-proxy"]' \
  --env '{}'
```

`--enable-proxy` routes the bridge's HTTPS through the container's OneCLI
gateway, which egress lockdown requires and which later injects the API key
(Phase 5) without the key ever entering the args or the container. The
`?profile=free` endpoint returns results without credentials, so the bridge
never triggers You.com's OAuth browser flow.

If the user asked for the Docs MCP in Phase 1, also register it (keyless, no
key needed at any tier):

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name youdotcom_docs \
  --command mcp-remote \
  --args '["https://you.com/docs/_mcp/server","--transport","http-only","--enable-proxy"]' \
  --env '{}'
```

Restart each selected group with a smoke-test message:

```bash
ncl groups restart \
  --id <group-id> \
  --message "You.com search is installed (free tier, you-search only). Run one you-search for 'nanoclaw' and report whether it succeeds. If youdotcom_docs is present, also run one searchDocs for 'MCP server' and report the top result."
```

## Phase 4: Verify

Confirm the stored configuration contains a `youdotcom` server (and
`youdotcom_docs` if you added it):

```bash
ncl groups config get --id <group-id>
```

Then check the selected agent's test response. The search call must use
`mcp__youdotcom__you-search`. If the Docs MCP was added, `searchDocs` must
return a You.com docs URL.

## Phase 5: Install the upgrade path

The free tier is keyless, `you-search` only, and capped at 100 queries per day
(shared across every group on the host). Install standing instructions so the
agent offers the API-key upgrade at the moment it hits the cap or needs a tool
the free tier does not expose (`you-contents`, `you-research`, `you-finance`,
`you-discover`), instead of dead-ending. For each selected group:

1. Resolve the OneCLI dashboard URL the user's browser can reach:

   ```bash
   docker inspect onecli --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^APP_URL='
   ```

   If the value is a loopback or container-bridge address (`127.0.0.1`,
   `172.17.0.1`, `host.docker.internal`), ask the operator which URL they open
   the OneCLI dashboard at, suggesting `http://127.0.0.1:10254` as the default.
   A public or tailnet `APP_URL` needs no question.
2. Gate the deeplink: `curl -fs <dashboard-url>/connections/custom` must return
   HTTP 200. If it does not (older OneCLI without the prefill route), replace
   step 2 of the template with: "Ask an operator to run, on the host:
   `onecli secrets create --name youdotcom --type generic --host-pattern
   api.you.com --header-name Authorization --value-format 'Bearer {value}'
   --file <key-file>`".
3. Substitute `{{ONECLI_DASHBOARD_URL}}` in
   [upgrade-instructions.md](upgrade-instructions.md) with the resolved URL and
   write the block into `groups/<group-folder>/instructions.prepend.md`:
   replace an existing `<!-- youdotcom-upgrade:start -->` to
   `<!-- youdotcom-upgrade:end -->` block in place, append otherwise. Do not
   write into `groups/<group-folder>/CLAUDE.md`; it is regenerated at spawn and
   appended blocks are lost.
4. Have the operator open the composed deeplink once and confirm the create
   dialog loads with host `api.you.com` prefilled. If they supplied a public
   URL while `APP_URL` was a loopback address, suggest setting the public URL in
   the OneCLI dashboard (Settings, Instance) so future links stay stable.
5. Restart each selected group: `ncl groups restart --id <group-id>`.

## Free-tier limit

If a You.com search returns HTTP `429` (daily cap reached), or the user asks for
content extraction, research, or finance while only `you-search` is registered,
the free tier is the constraint. With Phase 5 installed the agent offers the
upgrade on its own: the user creates a free API key and stores it through the
prefilled dashboard link; the key lands in the OneCLI vault and the gateway
injects it into the bridge's requests. The agent then re-registers the server
against the full endpoint (all six tools) and restarts the group. The agent
never sees the key.

## Troubleshooting

- `command not found: mcp-remote`: rebuild the image, then restart the group.
- You.com tools are absent: verify the group has a `youdotcom` MCP entry
  (`ncl groups config get --id <group-id>`), then restart it.
- The agent reports an OAuth or sign-in browser prompt instead of results: the
  server is not returning the free profile. Confirm the registered URL is
  exactly `https://api.you.com/mcp?profile=free` (keyless) or that the API key
  is stored in the vault for host `api.you.com` (keyed) — a keyed request with
  no injected credential falls back to You.com's OAuth challenge.
- Only `you-search` is available after the key upgrade: the full endpoint must
  request the tools explicitly. Re-register with
  `https://api.you.com/mcp?tools=you-search,you-contents,you-research,you-finance,you-balance,you-discover`.
- The server fails to connect: `--transport http-only` forces Streamable HTTP.
  For the Docs MCP only, if it will not connect, drop the
  `"--transport","http-only"` pair so the bridge negotiates transport itself.
- `429` on search: the shared free-tier daily cap is exhausted; see
  [Free-tier limit](#free-tier-limit) for the OneCLI upgrade path.
- The agent hits the cap but never offers the upgrade: check that
  `groups/<group-folder>/instructions.prepend.md` contains the
  `youdotcom-upgrade` block (Phase 5) and restart the group. A session that
  already discussed the limit keeps reasoning from that history; `/clear`
  starts a clean one.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure.

## References

- [You.com MCP Server](https://docs.you.com/developer-resources/mcp-server)
- [You.com API keys](https://you.com/platform/api-keys)
- [`mcp-remote`](https://github.com/geelen/mcp-remote)
