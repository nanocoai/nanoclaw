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

## Phase 1: Pre-flight

Check whether the bridge is already in the image manifest, then list the groups:

```bash
grep -n '"mcp-remote"' container/cli-tools.json || true
ncl groups list
```

Ask which agent groups should receive Tavily. If `mcp-remote` is already pinned
to a version other than `0.1.38`, stop and report the conflict instead of adding
a second entry.

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

## Keyless limit

If Tavily returns HTTP `429` or `monthly_cap_reached_bonus_eligible`, stop and
tell the user that the keyless allowance is exhausted. Keep credentials under
OneCLI management. This skill supports keyless access only because NanoClaw
does not currently provide a OneCLI-managed Tavily OAuth path.

## Troubleshooting

- `command not found: mcp-remote`: rebuild the image, then restart the group.
- Tavily tools are absent: verify the group has a `tavily` MCP entry, then
  restart it.
- Crawl, Map, or Research appears: restore all three `--ignore-tool` pairs.
- `429` or `monthly_cap_reached_bonus_eligible`: report the exhausted keyless
  allowance and keep the keyless configuration unchanged.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure.

## References

- [Tavily Remote MCP](https://github.com/tavily-ai/tavily-remote-mcp)
- [`mcp-remote`](https://github.com/geelen/mcp-remote)
