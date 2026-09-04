# Remove Zapier Tool

Reverse `/add-zapier-tool`. Every step is idempotent and applies only to state
owned by this skill. Removing the tool does not delete the Zapier account,
Zapier MCP server, connected apps, or action history.

## 1. Find affected groups

List groups and inspect their container config:

```bash
ncl groups list
ncl groups config get --id <group-id>
```

Record every group whose `zapier` entry has type `http`, exact URL
`https://mcp.zapier.com/api/v1/connect`, and no static headers, so only
skill-owned registrations are removed and restarted below. If the name points
somewhere else, leave it untouched and report the conflict.

## 2. Unregister Zapier

For every exact-match affected group, remove the runtime registration through
`ncl`:

```bash
ncl groups config remove-mcp-server --id <group-id> --name zapier
```

If the entry is already absent, skip that group.

## 3. Remove skill-owned gateway rules

Delete only block rules with this skill's exact name prefix and host. Leave all
other operator-created OneCLI rules untouched:

```bash
for rid in $(onecli rules list | jq -r '.data[] | select(.hostPattern=="mcp.zapier.com" and .action=="block" and (.name | startswith("Zapier MCP: blocked for "))) | .id'); do onecli rules delete --id "$rid"; done
```

## 4. Reverse selective-agent grants

Find the exact `Zapier MCP` secret metadata id. For each `selective` agent,
filter only that id out of its assigned secret list while preserving all other
assignments. Never call `set-secrets` for an `all`-mode agent:

```bash
S=$(onecli secrets list | jq -r '[.data[] | select(.name=="Zapier MCP" and .hostPattern=="mcp.zapier.com")][0].id // empty')
if [ -n "$S" ]; then onecli agents list | jq -r '.data[] | select(.secretMode=="selective") | .id' | while read -r aid; do ids=$(onecli agents secrets --id "$aid" | jq -r --arg sid "$S" '[.data[] | select(. != $sid)] | unique | join(",")'); onecli agents set-secrets --id "$aid" --secret-ids "$ids"; done; fi
```

The skill may have created missing OneCLI agent identity records early to place
fail-closed rules. Leave these shared, inert records in place: NanoClaw owns and
reuses them, and they contain unrelated runtime policy. All Zapier-specific
state on them is removed by steps 3 and 4.

## 5. Remove the vault credential when unused

First confirm no remaining agent-group config uses the Zapier endpoint and no
other local client relies on the exact OneCLI secret named `Zapier MCP`. If it
is shared, leave it in place. Otherwise delete it by metadata id without ever
printing its value:

```bash
onecli secrets list | jq -r '.data[] | select(.name=="Zapier MCP" and .hostPattern=="mcp.zapier.com") | .id'
onecli secrets delete --id <secret-id>
```

Revoking or deleting the corresponding server at https://mcp.zapier.com is an
optional separate Zapier-account action. Do it only when the operator confirms
that no other client uses that server.

## 6. Restart and verify

Restart only the groups recorded in step 1:

```bash
ncl groups restart --id <group-id>
```

Confirm each affected config no longer has a `zapier` MCP entry. On its next
spawn, the agent must no longer discover `mcp__zapier__*` tools.
