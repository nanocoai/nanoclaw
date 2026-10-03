---
name: add-keenable-tool
description: Add Keenable web search and page fetch as keyless remote MCP tools for selected NanoClaw agent groups. Use when installing web search or URL-to-markdown extraction without an API key or signup.
---

# Add Keenable Tool

Install the pinned `mcp-remote` bridge in the agent image and register Keenable's
remote MCP server for each selected agent group. The MCP server supplies its
tool descriptions and input schemas at runtime.

The registered server exposes:

- `mcp__keenable__search_web_pages`
- `mcp__keenable__fetch_page_content`

The registration is provider-agnostic: any provider with MCP support picks it
up (Claude, OpenCode, and Codex all do). Groups on the Claude provider already
have the built-in `WebSearch` and `WebFetch` tools
(`container/agent-runner/src/providers/claude.ts`), so the skill adds the most
for groups on other providers, and anywhere the extra query controls matter:
date filtering, point-in-time search, and instruction-driven extraction.

The server answers anonymously. An optional API key raises the rate limit and
changes nothing else.

## Phase 1: Pre-flight

Check whether the bridge is already in the image manifest, then list the groups:

```bash
grep -n '"mcp-remote"' container/cli-tools.json || true
ncl groups list
```

Ask which agent groups should receive Keenable. Then take one of two paths:

- **The manifest already has `mcp-remote` at an exact version.** Reuse that
  entry. Keep whatever version is pinned, even when it differs from the
  `0.1.38` below: it belongs to whichever skill installed it, and re-pinning it
  changes another skill's dependency. Skip the edit and the rebuild in Phase 2,
  and note the version you found when you report.
- **The manifest has no `mcp-remote`.** Apply Phase 2 in full.

## Phase 2: Install the MCP bridge

Add this object to the top-level array in `container/cli-tools.json`:

```json
{
  "name": "mcp-remote",
  "version": "0.1.38"
}
```

Keep the JSON valid and limit the entry to the two fields shown; this package
does not require a native build-script opt-in.

Copy the guards into the host test tree and run them:

```bash
cp .claude/skills/add-keenable-tool/keenable-manifest.test.ts src/keenable-manifest.test.ts
pnpm exec vitest run src/keenable-manifest.test.ts
```

Run the guards before building. They read `container/cli-tools.json` off the
host filesystem and never touch the image, so they catch a malformed entry in
seconds instead of after a build.

Then build the image so it carries the new global CLI tool:

```bash
./container/build.sh
```

On a standard install this is a full rebuild from the Node base image and takes
several minutes; on a hardened install it applies a lightweight overlay. Build
only when the manifest changed in this run. When Phase 1 found an existing
pinned entry, the image already carries the bridge and no rebuild is due.

## Phase 3: Register Keenable

`config add-mcp-server` and `groups restart` are approval-gated. Run from
inside a container they return `approval-pending` immediately; that is not an
error. Wait for the admin's approval and the follow-up system message before
moving on to Phase 4.

Register one server named `keenable` for each selected `<group-id>`, then
restart the same groups. Doing all the registrations first and all the restarts
after keeps the approval round-trips to two waves rather than two per group.

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name keenable \
  --command mcp-remote \
  --args '["https://api.keenable.ai/mcp?keenable_title=nanoclaw","--transport","http-only","--enable-proxy"]' \
  --env '{}'
```

`keenable_title` attributes the traffic to NanoClaw, which is how usage from
this skill is distinguished from every other client. Keep it in the URL.

```bash
ncl groups restart \
  --id <group-id> \
  --message "Keenable web search and page fetch are installed. Run one Keenable search with max_results 1 and report whether it succeeds."
```

The restart command returns `{ "restarted": <count> }`. A `0` means the group
has no running container right now, which is normal for a freshly configured
group: the registration is stored and gets picked up on the group's next
message. Record the count, it decides what Phase 4 can check.

## Phase 4: Verify

Confirm the stored configuration contains one `keenable` server:

```bash
ncl groups config get --id <group-id>
```

For a group whose restart reported `1` or higher, check the agent's test
response. The call must use `mcp__keenable__search_web_pages`.

For a group whose restart reported `0`, no test message was delivered. The
stored configuration above is the whole verification available now; the smoke
test runs on that group's next regular message.

## Rate limits

The anonymous tier allows 1,000 requests per hour and 10 per second, and the
allowance is shared by every group on the host, since it is keyed on the host's
IP address. See <https://docs.keenable.ai/rate-limits> for the current figures.

A `429` sends a `retry-after` header and a JSON-RPC error whose message points
at the authentication docs. The window is rolling, so retrying after the
interval is a complete fix.

An API key raises the ceiling and is created at
<https://keenable.ai/console>. Store it through OneCLI on the host, so the
gateway injects it per request and the agent never sees it. This needs OneCLI
configured; run `/init-onecli` first if `command -v onecli` finds nothing.

```bash
onecli secrets create --name keenable --type generic \
  --host-pattern api.keenable.ai --header-name X-API-Key --file <key-file>
```

## Troubleshooting

- `command not found: mcp-remote`: rebuild the image, then restart the group.
- Keenable tools are absent: verify the group has a `keenable` MCP entry, then
  restart it.
- Tool calls fail or hang: re-register the server with the exact URL and args
  from Phase 3. Both the `--enable-proxy` flag and the query string are
  load-bearing; the flag keeps the bridge routing through the OneCLI gateway
  under `NANOCLAW_EGRESS_LOCKDOWN=true`.
- `429`: the host's shared allowance is throttling. See
  [Rate limits](#rate-limits).

## Removal

See [REMOVE.md](REMOVE.md) for the removal procedure.

## References

- [Keenable MCP server](https://docs.keenable.ai/mcp-server)
- [Keenable API reference](https://docs.keenable.ai/api-reference)
- [Keenable rate limits](https://docs.keenable.ai/rate-limits)
- [`mcp-remote`](https://github.com/geelen/mcp-remote)
