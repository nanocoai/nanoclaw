# Remove FXMacroData Tool

Every step is idempotent. Apply it only to groups where `/add-fxmacrodata-tool`
was installed.

## 1. Unregister FXMacroData

List the groups and inspect their configurations:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

For every group with an `fxmacrodata` MCP entry:

```bash
ncl groups config remove-mcp-server --id <group-id> --name fxmacrodata
```

## 2. Remove the registration guard

```bash
rm -f src/fxmacrodata-mcp.test.ts
```

## 3. Remove the upgrade instructions

For every group whose `instructions.prepend.md` contains the
`fxmacrodata-upgrade` block:

```bash
perl -0pi -e 's/\n?<!-- fxmacrodata-upgrade:start -->.*?<!-- fxmacrodata-upgrade:end -->\n?//s' groups/<group-folder>/instructions.prepend.md
```

No-op when the block is absent.

## 4. Remove the stored key

Only if Phase 5 stored a key. Deleting the secret revokes it for every agent;
per-agent secret lists are not edited.

- **OneCLI**:

  ```bash
  for id in $(onecli secrets list | jq -r '.data[] | select(.name == "FXMacroData") | .id'); do onecli secrets delete --id "$id"; done
  ```

- **Iron Proxy**: delete the `mcp.fxmacrodata.com` secret in the Iron Control
  console. If `mcp.fxmacrodata.com` was added with `setup.ts --allow-host`
  only for this skill, delete that entry from Iron's allowed-hosts JSON file
  and rerun `pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts`.

## 5. Restart and verify

Restart every affected group:

```bash
ncl groups restart --id <group-id>
```

Confirm the server is absent:

```bash
ncl groups config get --id <group-id>
test ! -e src/fxmacrodata-mcp.test.ts
```
