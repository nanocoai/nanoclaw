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

`./container/build.sh` rebuilds the agent image to include the new global CLI
tool (`mcp-remote`). On a standard (non-hardened) install, this is a full
multi-GB rebuild from the Node base image and can take several minutes. On
hardened installs (where you pull a prebuilt image), it applies a lightweight
overlay. The rebuilding is necessary only on first install; if you are
reinstalling the skill, this step may be skipped on non-hardened installs if
you confirm the previous `./container/build.sh` run succeeded and `mcp-remote`
is already in the image.

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

The restart command returns `{ "restarted": <count> }`. If `restarted` is 0, the
group has no running container at the moment — this is normal for a freshly
configured group. The Tavily configuration will be picked up the next time the
group receives a message (a user sends a message to one of the group's wired
channels, or an incoming notification arrives). You can move to Phase 4, or
send a test message now to trigger the smoke test immediately.

## Phase 4: Verify

Confirm the stored configuration contains one `tavily` server with both
headers:

```bash
ncl groups config get --id <group-id>
```

If the group was restarted in Phase 3 (check for `"restarted": 1` or higher),
check the selected agent's test response. The call must use
`mcp__tavily__tavily_search`. Tavily Crawl, Map, and Research must not appear in
the Tavily namespace.

If `restarted` was 0, the test message was not delivered on restart. The group
will run the smoke test on its next regular message, or skip to Phase 5 now.

## Phase 5: Install the upgrade path

The keyless allowance is shared by every group on the host, so it can run out.
Install standing instructions so the agent offers the paid-key upgrade at that
moment instead of dead-ending. For each selected group:

1. Resolve the OneCLI dashboard URL the user's browser can reach:

   ```bash
   docker inspect onecli --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^APP_URL='
   ```

   Use the `APP_URL` value you see (e.g., `http://127.0.0.1:10254` or
   `http://172.17.0.1:10254`). If that address is unreachable from your browser
   (e.g., OneCLI is on a remote machine or behind a firewall), ask the operator
   which URL they use to reach the OneCLI dashboard instead. Otherwise, proceed
   with the `APP_URL` value.
2. Gate the deeplink: probe the exact URL the template emits after substitution.
   The template targets
   `{{ONECLI_DASHBOARD_URL}}/connections/secrets?create=generic&host=mcp.tavily.com&name=Tavily&header=Authorization&format=Bearer%20%7Bvalue%7D`;
   test it with `curl -fs '<dashboard-url>/connections/secrets?create=generic&host=mcp.tavily.com&name=Tavily&header=Authorization&format=Bearer%20%7Bvalue%7D'`.
   If it returns HTTP 200, the route is available. If it returns 404 (older
   OneCLI without the prefill route), replace step 2 of the template with: "Ask
   an operator to run, on the host: `onecli secrets create --name tavily --type
   generic --host-pattern mcp.tavily.com --header-name Authorization
   --value-format 'Bearer {value}' --file <key-file>`". If the probe fails with a
   connection error (connection refused, timeout), use the operator-supplied URL
   from step 1.
3. Substitute `{{ONECLI_DASHBOARD_URL}}` in
   [upgrade-instructions.md](upgrade-instructions.md) with the resolved URL and
   write the block into `groups/<group-folder>/instructions.prepend.md`:
   replace an existing `<!-- tavily-upgrade:start -->` to
   `<!-- tavily-upgrade:end -->` block in place, append otherwise. Do not write
   into `groups/<group-folder>/CLAUDE.md`; it is regenerated at spawn and
   appended blocks are lost.
4. Have the operator open the composed deeplink once and confirm the create
   dialog loads with host `mcp.tavily.com` prefilled. If the link does not load,
   revisit step 1 and verify the dashboard URL is correct for the operator's
   network.
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
