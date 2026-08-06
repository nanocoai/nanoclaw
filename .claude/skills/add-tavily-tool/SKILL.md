---
name: add-tavily-tool
description: Add Tavily Search and Extract as keyless remote MCP tools for selected NanoClaw agent groups. Use when installing Tavily web search or URL extraction without an API key.
---

# Add Tavily Tool

Install the pinned `mcp-remote` bridge in the agent image and register Tavily's
remote MCP server for each selected agent group. The MCP server supplies its
tool descriptions and input schemas at runtime.

The registered server exposes:

- `mcp__tavily__tavily_search`
- `mcp__tavily__tavily_extract`

The registration is provider-agnostic: any provider with MCP support picks it
up (Claude, OpenCode, and Codex all do). Groups on the Claude provider already
have the built-in `WebSearch` and `WebFetch` tools
(`container/agent-runner/src/providers/claude.ts`), so the skill adds the most
for groups on other providers, and for Tavily's structured extraction
anywhere.

## Phase 1: Pre-flight

Check whether the bridge is already in the image manifest, then list the groups:

```bash
grep -n '"mcp-remote"' container/cli-tools.json || true
ncl groups list
```

Ask which agent groups should receive Tavily. If `mcp-remote` is already
present at a pinned version, reuse the existing entry instead of adding a
second one.

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
cp .claude/skills/add-tavily-tool/tavily-manifest.test.ts src/tavily-manifest.test.ts
```

Build the image and run the guard:

```bash
./container/build.sh
pnpm exec vitest run src/tavily-manifest.test.ts
```

The manifest is the only source-backed integration point. Per-group MCP
registration is runtime state stored through `ncl`, so it has no in-tree line
for a registration test to guard.

## Phase 3: Register Tavily

`config add-mcp-server` and `groups restart` are approval-gated. Run from
inside a container they return `approval-pending` immediately; that is not an
error. Wait for the admin's approval and the follow-up system message before
moving on to Phase 4.

For each selected `<group-id>`, register one server named `tavily`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name tavily \
  --command mcp-remote \
  --args '["https://mcp.tavily.com/mcp/","--transport","http-only","--enable-proxy","--header","X-Tavily-Access-Mode:keyless","--header","X-Client-Name:nanoclaw","--ignore-tool","tavily_crawl","--ignore-tool","tavily_map","--ignore-tool","tavily_research"]' \
  --env '{}'
```

The keyless header enables Tavily's IP-based allowance. The client-name header
attributes calls to NanoClaw. The tool filters leave only Search and Extract
available.

Restart each selected group:

```bash
ncl groups restart \
  --id <group-id> \
  --message "Tavily Search and Extract are installed. Run one Tavily search with max_results 1 and report whether it succeeds."
```

## Phase 4: Verify

Confirm the stored configuration contains one `tavily` server with both
headers:

```bash
ncl groups config get --id <group-id>
```

Then check the selected agent's test response. The call must use
`mcp__tavily__tavily_search`. Tavily Crawl, Map, and Research must not appear in
the Tavily namespace.

## Phase 5: Install the upgrade path

The keyless allowance is shared by every group on the host, so it can run out.
Install standing instructions so the agent offers the paid-key upgrade at that
moment instead of dead-ending. For each selected group:

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
   `onecli secrets create --name tavily --type generic --host-pattern
   mcp.tavily.com --header-name Authorization --value-format 'Bearer {value}'
   --file <key-file>`".
3. Substitute `{{ONECLI_DASHBOARD_URL}}` in
   [upgrade-instructions.md](upgrade-instructions.md) with the resolved URL and
   write the block into `groups/<group-folder>/instructions.prepend.md`:
   replace an existing `<!-- tavily-upgrade:start -->` to
   `<!-- tavily-upgrade:end -->` block in place, append otherwise. Do not write
   into `groups/<group-folder>/CLAUDE.md`; it is regenerated at spawn and
   appended blocks are lost.
4. Have the operator open the composed deeplink once and confirm the create
   dialog loads with host `mcp.tavily.com` prefilled. If they supplied a public
   URL while `APP_URL` was a loopback address, suggest setting the public URL in
   the OneCLI dashboard (Settings, Instance) so future links stay stable.
5. Restart each selected group: `ncl groups restart --id <group-id>`.

## Keyless limit

If Tavily returns HTTP `429` or `monthly_cap_reached_bonus_eligible`, the
keyless allowance is exhausted. With Phase 5 installed the agent offers the
upgrade on its own: the user creates a free API key and stores it through the
prefilled dashboard link; the key lands in the OneCLI vault and the gateway
injects it into the bridge's requests. The agent then re-registers the server
without the `X-Tavily-Access-Mode:keyless` header and restarts the group. The
agent never sees the key.

## Troubleshooting

- `command not found: mcp-remote`: rebuild the image, then restart the group.
- Tavily tools are absent: verify the group has a `tavily` MCP entry, then
  restart it.
- Crawl, Map, or Research appears: restore all three `--ignore-tool` pairs.
- `429` or `monthly_cap_reached_bonus_eligible`: the keyless allowance is
  exhausted; see [Keyless limit](#keyless-limit) for the OneCLI upgrade path.
- The agent reports exhaustion but never offers the upgrade: check that
  `groups/<group-folder>/instructions.prepend.md` contains the
  `tavily-upgrade` block (Phase 5) and restart the group. A session that
  already discussed the limit keeps reasoning from that history; `/clear`
  starts a clean one.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure.

## References

- [Tavily Remote MCP](https://docs.tavily.com/documentation/mcp)
- [`mcp-remote`](https://github.com/geelen/mcp-remote)
