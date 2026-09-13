# Remove You.com Tool

Every step is idempotent. Apply it only to groups where `/add-youdotcom-tool`
was installed.

## 1. Unregister You.com

List the groups and inspect their configurations:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with a `youdotcom` MCP entry (and a `youdotcom_docs` entry, if
the Docs MCP was added):

```bash
ncl groups config remove-mcp-server --id <group-id> --name youdotcom
ncl groups config remove-mcp-server --id <group-id> --name youdotcom_docs
```

`remove-mcp-server` on an absent server is a no-op.

## 2. Remove the dependency guard

```bash
rm -f src/youdotcom-manifest.test.ts
```

## 3. Remove the upgrade instructions

For every group whose `instructions.prepend.md` contains the
`youdotcom-upgrade` block:

```bash
perl -0pi -e 's/\n?<!-- youdotcom-upgrade:start -->.*?<!-- youdotcom-upgrade:end -->\n?//s' groups/<group-folder>/instructions.prepend.md
```

No-op when the block is absent.

## 4. Remove the stored API-key secret

If Phase 5 stored a You.com key in the OneCLI vault and no other use remains,
remove it on the host:

```bash
onecli secrets list | grep -i you.com || true
onecli secrets delete --name youdotcom
```

Leave it in place if another group still uses You.com with a key.

## 5. Remove the MCP bridge

If `/add-youdotcom-tool` added `mcp-remote` and no other configured MCP server
uses that command (e.g. `/add-tavily-tool`), remove its complete object from
`container/cli-tools.json`. Keep the top-level array valid. Leave a pre-existing
or shared entry in place.

Rebuild the image when the manifest changed:

```bash
./container/build.sh
```

## 6. Restart and verify

Restart every affected group:

```bash
ncl groups restart --id <group-id>
```

Confirm the servers are absent:

```bash
ncl groups config get --id <group-id>
test ! -e src/youdotcom-manifest.test.ts
```
