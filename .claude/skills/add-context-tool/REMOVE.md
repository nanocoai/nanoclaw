# Remove Context.dev Tool

Every step is idempotent. Apply it only to groups where
`/add-context-tool` was installed.

## 1. Unregister Context.dev

List the groups and inspect their configurations:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with a `context` MCP entry:

```bash
ncl groups config remove-mcp-server --id <group-id> --name context
```

## 2. Remove the dependency guard

```bash
rm -f src/context-manifest.test.ts
```

## 3. Remove the MCP bridge

If `/add-context-tool` added `mcp-remote` and no other configured MCP server
uses that command, remove its complete object from `container/cli-tools.json`.
Keep the top-level array valid. Leave a pre-existing or shared entry in place.

Rebuild the image when the manifest changed:

```bash
./container/build.sh
```

## 4. Remove the credential

Ask the operator whether any other workload uses the Context.dev secret in
OneCLI. If none does, ask them to delete the secret for `mcp.context.dev`
through the OneCLI dashboard. Never retrieve or display the stored value.

## 5. Restart and verify

Restart every affected group:

```bash
ncl groups restart --id <group-id>
```

Confirm the server and dependency guard are absent:

```bash
ncl groups config get --id <group-id>
test ! -e src/context-manifest.test.ts
```
