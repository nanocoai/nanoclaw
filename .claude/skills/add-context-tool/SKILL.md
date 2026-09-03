---
name: add-context-tool
description: Add Context.dev live web search, scraping, crawling, extraction, document parsing, news, and brand intelligence as remote MCP tools for selected NanoClaw agent groups.
---

# Add Context.dev Tool

Register Context.dev's hosted MCP server with selected NanoClaw agent groups.
NanoClaw connects through its native remote-MCP support, and OneCLI injects the
Context.dev API key without exposing it to the agent or storing it in NanoClaw
configuration.

Context.dev also exposes monitor and batch operations that can consume credits
or change account state. Tell the operator that those tools will be available
and should only be used when they explicitly request the corresponding action.

## Phase 1: Pre-flight

Confirm NanoClaw and OneCLI are available, then list the groups:

```bash
ncl groups list --json
onecli version
```

If OneCLI is unavailable, stop and ask the operator to run `/init-onecli`, then
re-run this skill.

Ask which agent groups should receive Context.dev. Accept group IDs from
`ncl groups list --json`, not display names. Inspect each selected group's
configuration before changing it:

```bash
ncl groups config get --id <group-id>
```

## Phase 2: Store the credential in OneCLI

Check whether a Context.dev credential already exists:

```bash
onecli secrets list | jq -e '.data[] | select(.name == "Context.dev")'
```

If it exists, reuse it. Otherwise, tell the operator to create an API key at
[context.dev/dashboard](https://context.dev/dashboard), then resolve the OneCLI
dashboard URL their browser can reach:

```bash
docker inspect onecli --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^APP_URL='
```

If `APP_URL` is a loopback or container-bridge address, ask which URL the
operator uses to open OneCLI, suggesting `http://127.0.0.1:10254`. A public or
tailnet URL needs no question.

Confirm the custom-secret page exists:

```bash
curl -fs <dashboard-url>/connections/custom >/dev/null
```

Ask the operator to open this prefilled URL and paste the key directly into
OneCLI:

```text
<dashboard-url>/connections/secrets?create=generic&host=mcp.context.dev&name=Context.dev&header=Authorization&format=Bearer%20%7Bvalue%7D
```

Never ask them to paste the key into chat, a shell command, an environment
variable, or NanoClaw configuration. Verify the credential exists before
continuing:

```bash
onecli secrets list | jq -e '.data[] | select(.name == "Context.dev")'
```

## Phase 3: Scope the credential to selected agents

NanoClaw identifies each OneCLI agent by its group ID. A group that has never
spawned may not have an OneCLI agent yet, so create any missing entries using
the same identifiers as NanoClaw:

```bash
GROUPS=$(ncl groups list --json)
AGENTS=$(onecli agents list)
printf '%s' "$GROUPS" | jq -r '.data[] | "\(.id)\t\(.name)"' |
while IFS="$(printf '\t')" read -r group_id group_name; do
  printf '%s' "$AGENTS" | jq -e --arg id "$group_id" \
    '.data[] | select(.identifier == $id)' >/dev/null ||
    onecli agents create --name "$group_name" --identifier "$group_id"
done
```

For every selected group whose OneCLI agent uses `selective` secret mode, merge
the Context.dev secret into its existing list. Do not call `set-secrets` for an
agent in `all` mode because doing so would silently switch it to selective mode:

```bash
CONTEXT_SECRET_ID=$(onecli secrets list | jq -r \
  'first(.data[] | select(.name == "Context.dev")) | .id // empty')
test -n "$CONTEXT_SECRET_ID"

ONECLI_AGENT_ID=$(onecli agents list | jq -r --arg id '<group-id>' \
  'first(.data[] | select(.identifier == $id)) | .id // empty')
SECRET_MODE=$(onecli agents list | jq -r --arg id '<group-id>' \
  'first(.data[] | select(.identifier == $id)) | .secretMode // empty')

if [ "$SECRET_MODE" = selective ]; then
  SECRET_IDS=$(onecli agents secrets --id "$ONECLI_AGENT_ID" | jq -r \
    --arg context "$CONTEXT_SECRET_ID" '[.data[], $context] | unique | join(",")')
  onecli agents set-secrets --id "$ONECLI_AGENT_ID" --secret-ids "$SECRET_IDS"
fi
```

Repeat only the final block for each selected group.

## Phase 4: Register Context.dev

`config add-mcp-server` and `groups restart` are approval-gated. When run from
inside an agent container they return `approval-pending`; wait for the admin's
decision and follow-up system message before verifying.

Register the native HTTP server for each selected group:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name context \
  --url https://mcp.context.dev/mcp \
  --headers '{"X-Client-Name":"NanoClaw"}'
```

The registration contains no credential. OneCLI adds
`Authorization: Bearer <key>` only when traffic is sent to
`mcp.context.dev`.

Restart each selected group and request a read-only smoke test:

```bash
ncl groups restart \
  --id <group-id> \
  --message "Context.dev is installed. Use a Context.dev MCP tool to find the latest official NanoClaw release, return one result with its source URL, and report the tool name you used."
```

## Phase 5: Verify

Confirm each selected group contains exactly one `context` server with type
`http`, the URL `https://mcp.context.dev/mcp`, and no authorization header:

```bash
ncl groups config get --id <group-id>
```

The smoke-test response must use a tool in the `mcp__context__` namespace,
include a cited URL, and report no authentication or transport error. Do not
invoke monitor or batch mutation tools during verification.

## Troubleshooting

- `401`, `Missing Authorization header`, or `Invalid token`: confirm OneCLI has
  the `Context.dev` generic secret for host `mcp.context.dev` with header
  `Authorization` and format `Bearer {value}`. If the OneCLI agent is in
  selective mode, confirm the secret ID is assigned to it.
- Context.dev tools are absent: confirm the group has one native HTTP `context`
  entry, then restart the group.
- `approval-pending`: wait for the operator to approve the configuration or
  restart request; do not submit duplicates.
- A write-capable tool appears: this is expected for the public Context.dev MCP
  catalog. Use it only after an explicit operator request.

## Removal

See [REMOVE.md](REMOVE.md) for the idempotent removal procedure.

## References

- [Context.dev documentation](https://docs.context.dev)
- [Context.dev MCP server](https://mcp.context.dev/mcp)
