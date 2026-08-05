# Remove Tavily Tool

Every step is idempotent. Apply it only to groups where `/add-tavily-tool` was
installed.

## 1. Unregister Tavily

List the groups and inspect their configurations:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with a `tavily` MCP entry:

```bash
ncl groups config remove-mcp-server --id <group-id> --name tavily
```

## 2. Remove the dependency guard

```bash
rm -f src/tavily-manifest.test.ts
```

## 3. Remove the MCP bridge

If `/add-tavily-tool` added `mcp-remote` and no other configured MCP server uses
that command, remove its complete object from `container/cli-tools.json`. Keep
the top-level array valid. Leave a pre-existing or shared entry in place.

Rebuild the image when the manifest changed:

```bash
./container/build.sh
```

## 4. Restart and verify

Restart every affected group:

```bash
ncl groups restart --id <group-id>
```

Confirm the server is absent:

```bash
ncl groups config get --id <group-id>
test ! -e src/tavily-manifest.test.ts
```
