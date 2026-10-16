# Remove Graphiti

Every step is idempotent. Steps 1–2 detach agents from memory without touching
the stored graph; step 5 is the only destructive one and needs the user's
explicit confirmation.

## 1. Unregister Graphiti

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with a `graphiti` MCP entry:

```bash
ncl groups config remove-mcp-server --id <group-id> --name graphiti
```

## 2. Remove the standing instructions

For every group whose `instructions.prepend.md` contains the `graphiti-memory`
block:

```bash
perl -0pi -e 's/\n?<!-- graphiti-memory:start -->.*?<!-- graphiti-memory:end -->\n?//s' groups/<folder>/instructions.prepend.md
```

No-op when the block is absent. Restart each affected group:

```bash
ncl groups restart --id <group-id>
```

## 3. Stop the stack

```bash
docker compose -p nanoclaw-graphiti -f data/graphiti/docker-compose.yml down
```

This keeps the `neo4j_data` volume, so reinstalling restores all memory.
Repeat with `-p nanoclaw-graphiti-<folder>` for any per-group stacks.

## 4. Remove the dependency guard and bridge

```bash
rm -f src/graphiti-manifest.test.ts
```

If `/add-graphiti` added `mcp-remote` and no remaining MCP server uses that
command (check `ncl groups config get` for every group — `/add-tavily-tool`
uses it too), remove its object from `container/cli-tools.json`, keep the
array valid, and rebuild:

```bash
./container/build.sh
```

## 5. Delete the memory (optional, destructive)

Only when the user explicitly confirms they want the knowledge graph gone:

```bash
docker compose -p nanoclaw-graphiti -f data/graphiti/docker-compose.yml down -v
rm -rf data/graphiti
```

`-v` deletes the `neo4j_data` and `neo4j_logs` volumes. `data/graphiti/.env`
holds the LLM API key; deleting the directory removes it from disk.

## 6. Verify

```bash
ncl groups config get --id <group-id>          # no "graphiti" server
test ! -e src/graphiti-manifest.test.ts
docker compose -p nanoclaw-graphiti ps 2>/dev/null   # nothing running
```
