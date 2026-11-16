# Remove LanceDB Memory

Every step is idempotent. Apply it only to groups where `/add-lancedb-memory`
was installed.

## 1. Unregister the server and the package

List the groups and inspect their configurations:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with a `lancedb_memory` MCP entry or the `memory-lancedb-pro`
package:

```bash
ncl groups config remove-mcp-server --id <group-id> --name lancedb_memory
ncl groups config remove-package --id <group-id> --npm memory-lancedb-pro@1.1.0-beta.9
```

`remove-mcp-server` reports an error when the entry is already gone; that is
fine. These commands are approval-gated when run from inside a container.

## 2. Rebuild and restart each group

When the group still has other packages, rebuild its image without the library:

```bash
ncl groups restart --id <group-id> --rebuild
```

When `memory-lancedb-pro` was its only package, there is nothing left to build.
Point the group back at the base image and restart it instead:

```bash
ncl groups config update --id <group-id> --image-tag ""
ncl groups restart --id <group-id>
```

## 3. Remove the embedding key

If no other tool uses the embedding provider's key, delete its secret from the
credential gateway. With OneCLI, find it by host pattern and delete it:

```bash
onecli secrets list --max 0
onecli secrets delete --id <secret-id>
```

## 4. Delete the copied files

```bash
rm -f container/agent-runner/src/lancedb-memory-mcp.ts \
      container/agent-runner/src/lancedb-memory-mcp.test.ts
rm -rf container/skills/lancedb-memory
```

Running containers keep the removed server until they restart; step 2 already
restarted the selected groups.

## 5. Delete stored memories (optional)

The store is the agent's data. Delete it only when the operator asks to:

```bash
rm -rf groups/<group-folder>/lancedb-memory
```

## Verify

```bash
ncl groups config get --id <group-id>
test ! -e container/agent-runner/src/lancedb-memory-mcp.ts
test ! -e container/skills/lancedb-memory
```

The configuration shows no `lancedb_memory` server and no
`memory-lancedb-pro` package.
