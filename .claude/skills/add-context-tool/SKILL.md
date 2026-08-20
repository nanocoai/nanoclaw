---
name: add-context-tool
description: Add Context.dev web search, scraping, extraction, parsing, brand intelligence, monitors, and batches as remote MCP tools for selected NanoClaw agent groups.
---

# Add Context.dev Tool

Install the pinned `mcp-remote` bridge in the agent image and register the
Context.dev remote MCP server for selected agent groups. Context.dev supplies
the tool descriptions and input schemas at runtime.

Context.dev supports two access modes:

- **Standard (recommended):** exposes web search, scraping, crawling,
  extraction, document parsing, screenshots, brand intelligence, and read-only
  monitor and batch inspection. It omits tools that create, modify, delete, or
  immediately run monitors and batches.
- **Full:** exposes the complete public Context.dev MCP catalog, including
  monitor and batch operations that consume credits or change account state.

Web scraping tools can optionally execute browser actions on third-party pages.
Agents must use those actions only when the user explicitly requests them.

## Phase 1: Pre-flight

Check whether the bridge is already in the image manifest, then list the groups:

```bash
grep -n '"mcp-remote"' container/cli-tools.json || true
ncl groups list
```

Ask which agent groups should receive Context.dev and whether each group should
use Standard or Full access. Use Standard unless the operator explicitly asks
for monitor or batch writes. Inspect each selected group's current
configuration before changing it:

```bash
ncl groups config get --id <group-id>
```

If `mcp-remote` is already present at a pinned version, reuse the existing entry
instead of adding a second one. If a selected group already has a `context`
server with the requested configuration, leave it unchanged.

## Phase 2: Install the MCP bridge

Add this object to the top-level array in `container/cli-tools.json` when an
entry named `mcp-remote` is not already present:

```json
{
  "name": "mcp-remote",
  "version": "0.1.38"
}
```

Keep the JSON valid and limit the entry to the two fields shown. Copy the
dependency guard into the host test tree:

```bash
cp .claude/skills/add-context-tool/context-manifest.test.ts src/context-manifest.test.ts
```

Build the image and run the guard:

```bash
./container/build.sh
pnpm exec vitest run src/context-manifest.test.ts
```

The manifest is the only source-backed integration point. Per-group MCP
registration is runtime state stored through `ncl`, so there is no in-tree line
for a registration test to guard.

## Phase 3: Store the Context.dev credential

Context.dev API keys work with the MCP endpoint through the `Authorization`
header. The key must live in OneCLI so the gateway injects it at the network
boundary. Never place it in NanoClaw configuration, command arguments, an
environment variable, a source file, or chat.

If the operator does not have a Context.dev API key, ask them to create one at
[context.dev/dashboard](https://context.dev/dashboard). Resolve the OneCLI
dashboard URL they can reach:

```bash
docker inspect onecli --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^APP_URL='
```

If the value is a loopback or container-bridge address (`127.0.0.1`,
`172.17.0.1`, or `host.docker.internal`), ask which URL the operator uses to
open OneCLI, suggesting `http://127.0.0.1:10254` as the default. A public or
tailnet `APP_URL` needs no question.

Confirm the custom-secret page exists:

```bash
curl -fs <dashboard-url>/connections/custom >/dev/null
```

When it succeeds, ask the operator to open this URL and paste the Context.dev
key directly into OneCLI:

```text
<dashboard-url>/connections/secrets?create=generic&host=mcp.context.dev&name=Context.dev&header=Authorization&format=Bearer%20%7Bvalue%7D
```

If the custom-secret page is unavailable, ask the operator to write the key to
a temporary permission-restricted file and run this command on the host:

```bash
onecli secrets create \
  --name context \
  --type generic \
  --host-pattern mcp.context.dev \
  --header-name Authorization \
  --value-format 'Bearer {value}' \
  --file <key-file>
```

They must delete the temporary file after OneCLI confirms the secret was
stored. Do not ask them to paste the key into the command line or chat.

## Phase 4: Register Context.dev

`config add-mcp-server` and `groups restart` are approval-gated. Run from
inside a container they return `approval-pending` immediately; that is not an
error. Wait for the admin's approval and the follow-up system message before
verifying the installation.

For each selected `<group-id>` using Standard access, register one server named
`context`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name context \
  --command mcp-remote \
  --args '["https://mcp.context.dev/mcp","--transport","http-only","--enable-proxy","--header","X-Client-Name:NanoClaw","--ignore-tool","create-monitor","--ignore-tool","update-monitor","--ignore-tool","delete-monitor","--ignore-tool","run-monitor-now","--ignore-tool","submit-batch","--ignore-tool","cancel-batch","--ignore-tool","delete-batch"]' \
  --env '{}'
```

For each selected group using Full access, omit the seven `--ignore-tool`
pairs:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name context \
  --command mcp-remote \
  --args '["https://mcp.context.dev/mcp","--transport","http-only","--enable-proxy","--header","X-Client-Name:NanoClaw"]' \
  --env '{}'
```

Restart each selected group:

```bash
ncl groups restart \
  --id <group-id> \
  --message "Context.dev is installed. Search the web for the latest official NanoClaw release, return one result, cite its URL, and report the Context.dev tool name you used."
```

## Phase 5: Verify

Confirm the stored configuration contains exactly one `context` server, uses
`mcp-remote`, points to `https://mcp.context.dev/mcp`, and enables the proxy:

```bash
ncl groups config get --id <group-id>
```

Check the selected agent's test response. It must use a tool in the
`mcp__context__` namespace, return a cited URL, and report no authentication or
transport error.

For Standard access, confirm these tools are absent:

- `mcp__context__create-monitor`
- `mcp__context__update-monitor`
- `mcp__context__delete-monitor`
- `mcp__context__run-monitor-now`
- `mcp__context__submit-batch`
- `mcp__context__cancel-batch`
- `mcp__context__delete-batch`

For Full access, confirm the tools are present. Do not invoke them during the
smoke test.

## Troubleshooting

- `command not found: mcp-remote`: rebuild the image, then restart the group.
- `401`, `Missing Authorization header`, or `Invalid token`: confirm OneCLI has
  a generic secret for `mcp.context.dev` with header `Authorization` and format
  `Bearer {value}`, then confirm the bridge uses `--enable-proxy`.
- Context.dev tools are absent: verify the group has one `context` MCP entry,
  then restart it.
- A Standard group exposes monitor or batch write tools: restore all seven
  `--ignore-tool` pairs and restart the group.
- The operator wants additional capabilities: re-register the server with the
  Full arguments and restart the group.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure.

## References

- [Context.dev documentation](https://docs.context.dev)
- [Context.dev MCP server](https://mcp.context.dev/mcp)
- [`mcp-remote`](https://github.com/geelen/mcp-remote)
