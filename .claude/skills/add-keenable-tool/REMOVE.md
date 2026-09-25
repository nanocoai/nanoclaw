# Remove Keenable Tool

Every step is idempotent when applied in order per the checks below. Apply this
only to groups where `/add-keenable-tool` was installed.

## 1. Unregister Keenable

Work from the group list the install produced. If it is lost, rediscover it:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with a `keenable` MCP entry (see the `mcp_servers` field):

```bash
ncl groups config remove-mcp-server --id <group-id> --name keenable
```

On a second run this errors with "MCP server 'keenable' not found", which means
the removal is already complete. The `config get` check above is what keeps the
command off groups that never had the entry.

## 2. Remove the guards

```bash
rm -f src/keenable-manifest.test.ts
```

## 3. Remove the MCP bridge, only if nothing else uses it

`mcp-remote` is a shared bridge: other skills register their servers through
the same command, and the manifest records no owner. Decide by what is
configured now, not by who installed it.

```bash
ncl groups list
ncl groups config get --id <group-id>   # for every group, not only ours
```

Keep the `mcp-remote` entry in `container/cli-tools.json` if any remaining MCP
server on any group has `mcp-remote` as its command. Remove its complete object
only when none does, keeping the top-level array valid.

A rebuild is not required either way. Nothing invokes the bridge once the
registrations are gone, and the smaller image arrives with the next
`./container/build.sh` for whatever reason it is next run.

## 4. Restart and verify

Restart every group touched in step 1:

```bash
ncl groups restart --id <group-id>
```

Confirm the server is absent:

```bash
ncl groups config get --id <group-id>
test ! -e src/keenable-manifest.test.ts
```
