# Remove Context.dev Tool

Every step is idempotent. Apply it only to groups where `/add-context-tool` was
installed.

## 1. Unregister Context.dev

List the groups and inspect their configurations:

```bash
ncl groups list --json
ncl groups config get --id <group-id>
```

For every group with a `context` MCP entry:

```bash
ncl groups config remove-mcp-server --id <group-id> --name context
```

## 2. Remove the credential if it is unused

Ask the operator whether another workload uses the Context.dev secret in
OneCLI. If none does, delete only the secret named exactly `Context.dev`:

```bash
CONTEXT_SECRET_ID=$(onecli secrets list | jq -r \
  'first(.data[] | select(.name == "Context.dev")) | .id // empty')
if [ -n "$CONTEXT_SECRET_ID" ]; then
  onecli secrets delete --id "$CONTEXT_SECRET_ID"
fi
```

Deleting the secret revokes it for every OneCLI agent, including agents in
selective mode, without replacing or narrowing any agent's existing secret
list.

## 3. Restart and verify

Restart every affected group:

```bash
ncl groups restart --id <group-id>
```

Confirm the `context` server is absent:

```bash
ncl groups config get --id <group-id>
```
