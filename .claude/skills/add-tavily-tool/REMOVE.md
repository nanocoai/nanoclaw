# Remove Tavily Tool

Every step is idempotent when applied in order per the checks below. Apply this
only to groups where `/add-tavily-tool` was installed.

## 1. Unregister Tavily

List the groups and inspect their configurations:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with a `tavily` MCP entry (see the `mcp_servers` field above):

```bash
ncl groups config remove-mcp-server --id <group-id> --name tavily
```

On a second run, this command will error with "MCP server 'tavily' not found" —
that is expected, and the removal is complete. The `config get` check above
prevents you from calling the remove command on groups that don't have the
entry.

## 2. Remove the dependency guard

```bash
rm -f src/tavily-manifest.test.ts
```

## 3. Remove the upgrade instructions

For every group whose `instructions.prepend.md` contains the `tavily-upgrade`
block:

```bash
perl -0pi -e 's/\n?<!-- tavily-upgrade:start -->.*?<!-- tavily-upgrade:end -->\n?//s' groups/<group-folder>/instructions.prepend.md
```

No-op when the block is absent.

## 4. Remove the MCP bridge

If `/add-tavily-tool` added `mcp-remote` and no other configured MCP server uses
that command, remove its complete object from `container/cli-tools.json`. Keep
the top-level array valid. Leave a pre-existing or shared entry in place.

Rebuild the image when the manifest changed:

```bash
./container/build.sh
```

## 5. Restart and verify

Restart every affected group:

```bash
ncl groups restart --id <group-id>
```

Confirm the server is absent:

```bash
ncl groups config get --id <group-id>
test ! -e src/tavily-manifest.test.ts
```
