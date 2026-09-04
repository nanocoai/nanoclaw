---
name: add-zapier-tool
description: Add Zapier's hosted Streamable HTTP MCP server to selected NanoClaw agent groups with a connection token stored in OneCLI. Use when agents need controlled access to Zapier-connected apps; this is a tool, not a messaging channel.
---

# Add Zapier Tool

Connect selected NanoClaw agent groups to Zapier's hosted MCP server. Zapier
supplies tool descriptions, dynamic discovery, and onboarding instructions at
runtime, so this installer does not add an adapter, package, or container skill.

The connection token is a password: it can run the server's tools and read the
data they return. Never ask the operator to paste a token or a token-bearing URL
into chat, never put one in a command, environment variable, NanoClaw config,
log, or repository file, and never print one. Use the OneCLI dashboard's secret
value field. Register only Zapier's public, credential-free endpoint:
`https://mcp.zapier.com/api/v1/connect`.

Every step is safe to re-run. The only functional integration is runtime state
written through `ncl groups config` and OneCLI; there is no source-level
integration point for an in-tree test to guard. Do not invent a structural test
for a line this skill never adds. This directive-bearing workflow does have an
`apply-fixtures.json` conformance fixture, as required by NanoClaw's skill
guidelines.

## Pre-flight

Run from the NanoClaw checkout on the host. OneCLI, `ncl`, and `jq` are required:

```nc:run effect:check
command -v onecli >/dev/null && command -v ncl >/dev/null && command -v jq >/dev/null
```

If OneCLI is missing, run `/init-onecli`, then re-run this skill. If `ncl`
cannot list groups, start the NanoClaw service before continuing.

List the groups:

```nc:run capture:agent_groups effect:fetch
ncl groups list --json | jq -r 'if (.data|length)==0 then "no agent groups yet" else [.data[] | "\(.id) (\(.name))"] | join(", ") end'
```

Stop if there are no groups. Ask which groups should receive Zapier:

```nc:operator
Agents on this install: {{agent_groups}}. A selected agent can use every action its Zapier MCP server exposes. Prefer a dedicated Zapier server in manual mode with only the actions this agent needs. Unselected existing agents will be blocked from the Zapier MCP host at the OneCLI gateway.
```
```nc:prompt zapier_agents validate:^ag-[A-Za-z0-9-]+(,ag-[A-Za-z0-9-]+)*$ normalize:trim
Which agents should receive Zapier? Enter one or more agent ids separated by commas with no spaces (the `ag-...` values shown above).
```

Validate every selected id. A typo must not broaden or silently remove access:

```nc:run effect:check
for gid in $(printf '%s' '{{zapier_agents}}' | tr ',' ' '); do ncl groups list --json | jq -e --arg id "$gid" '.data[] | select(.id==$id)' >/dev/null || { echo "unknown agent group '$gid' — see: ncl groups list" >&2; exit 1; }; done
```

## Create or select the Zapier MCP server

Tell the operator:

```nc:operator
Open https://mcp.zapier.com and create or select a dedicated MCP server for NanoClaw. For least privilege, use manual configuration and enable only the actions these agents need; dynamic discovery lets an agent enable additional actions itself. In the server's Connect tab, generate a connection token and copy the token alone—not the URL containing it. Keep that page open. Do not paste the token into this chat or any terminal command.
```

Zapier shows a token only once. If it is lost or exposed, regenerate it; doing
so immediately invalidates the old token.

## Store the token in OneCLI

Resolve the OneCLI dashboard address without reading any credential:

```nc:run capture:onecli_app_url validate:^https?://\S+$ effect:fetch
U=$(docker inspect onecli 2>/dev/null | jq -r '.[0].Config.Env[]? | select(startswith("APP_URL=")) | sub("^APP_URL="; "")' | head -1); U=${U:-http://127.0.0.1:10254}; printf '%s\n' "$U" | sed 's#^http://host.docker.internal#http://127.0.0.1#; s#^http://172\.17\.0\.1#http://127.0.0.1#'
```

Have the operator create or update one exact-name secret in the dashboard:

```nc:operator
Open {{onecli_app_url}}/connections/custom and create or update a generic secret with name `Zapier MCP`, host pattern `mcp.zapier.com`, header name `Authorization`, and value format `Bearer {value}`. Paste the token into the dashboard's secret value field, save it, then return here. Never paste the token into chat. If `Zapier MCP` already exists, update it only when you intend to rotate this NanoClaw connection.
```

Confirm only the secret metadata. This command must not print secret values:

```nc:run capture:zapier_secret_id validate:^\S+$ effect:fetch
onecli secrets list | jq -r '[.data[] | select(.name=="Zapier MCP" and .hostPattern=="mcp.zapier.com")][0].id // empty'
```

If no id is returned, the dashboard entry is missing or its name/host differs.
Correct it in OneCLI and retry. Never fall back to `--value`, a token file
created from chat, or a token-bearing MCP URL.

Before changing runtime config, make sure the skill-owned name is free or
already points to the exact public endpoint with no static headers. Stop on a
conflict: never overwrite another integration that happens to be named
`zapier`.

```nc:run effect:check
for gid in $(printf '%s' '{{zapier_agents}}' | tr ',' ' '); do C=$(ncl groups config get --id "$gid" --json) || exit 1; printf '%s' "$C" | jq -e '.data.mcp_servers.zapier == null or (.data.mcp_servers.zapier.type=="http" and .data.mcp_servers.zapier.url=="https://mcp.zapier.com/api/v1/connect" and ((.data.mcp_servers.zapier.headers // {}) | length)==0)' >/dev/null || { echo "group '$gid' already has a different MCP server named zapier; choose another name or remove that entry explicitly, then re-run" >&2; exit 1; }; done
```

## Enforce the group selection at the gateway

NanoClaw creates an OneCLI agent per agent group on first spawn. Create only
missing entries using the same stable identifier as the runtime:

```nc:run effect:wire
G=$(ncl groups list --json) || exit 1; AG=$(onecli agents list) || exit 1; printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name)"' | while IFS="$(printf '\t')" read -r gid gname; do printf '%s' "$AG" | jq -e --arg gid "$gid" '.data[] | select(.identifier==$gid)' >/dev/null || onecli agents create --name "$gname" --identifier "$gid" >/dev/null || exit 1; done
```

This may materialize dormant groups' runtime-owned OneCLI agent records early
so a fail-closed rule can exist before their first spawn. Removal intentionally
retains those inert identity records: NanoClaw owns and reuses them, and deleting
them could disturb unrelated credentials or policy. The Zapier secret grants
and every Zapier-specific rule are removed by `REMOVE.md`.

Synchronize only this skill's block rules. Selected groups have no Zapier
block; every other existing group has one enabled. Operator-created rules are
left untouched:

```nc:run effect:wire
A='{{zapier_agents}}'; G=$(ncl groups list --json) || exit 1; AG=$(onecli agents list) || exit 1; RL=$(onecli rules list) || exit 1; printf '%s' "$G" | jq -r '.data[] | "\(.id)\t\(.name)"' | while IFS="$(printf '\t')" read -r gid gname; do aid=$(printf '%s' "$AG" | jq -r --arg gid "$gid" 'first(.data[] | select(.identifier==$gid)) | .id // empty'); [ -n "$aid" ] || exit 1; rids=$(printf '%s' "$RL" | jq -r --arg aid "$aid" '.data[] | select(.hostPattern=="mcp.zapier.com" and .action=="block" and .agentId==$aid and (.name | startswith("Zapier MCP: blocked for ")) and ((.pathPattern // "")=="") and ((.method // "")=="")) | .id'); case ",$A," in *,"$gid",*) for rid in $rids; do onecli rules delete --id "$rid" >/dev/null || exit 1; done; echo "allowed: $gname ($gid)";; *) rid=$(printf '%s\n' "$rids" | sed -n '1p'); if [ -z "$rid" ]; then onecli rules create --name "Zapier MCP: blocked for $gname" --host-pattern mcp.zapier.com --action block --agent-id "$aid" --enabled >/dev/null || exit 1; else onecli rules update --id "$rid" --enabled true >/dev/null || exit 1; printf '%s\n' "$rids" | sed '1d' | while read -r duplicate; do [ -z "$duplicate" ] || onecli rules delete --id "$duplicate" >/dev/null || exit 1; done; fi; echo "blocked: $gname ($gid)";; esac; done
```

For selected agents in OneCLI `selective` secret mode, merge the Zapier secret
into their existing lists. Never call `set-secrets` for an `all`-mode agent,
because that would silently switch it to selective mode:

```nc:run effect:wire
A='{{zapier_agents}}'; S='{{zapier_secret_id}}'; onecli agents list | jq -r '.data[] | select(.secretMode=="selective") | "\(.id)\t\(.identifier)"' | while IFS="$(printf '\t')" read -r aid gid; do case ",$A," in *,"$gid",*) ids=$(onecli agents secrets --id "$aid" | jq -r --arg sid "$S" '[.data[], $sid] | unique | join(",")'); onecli agents set-secrets --id "$aid" --secret-ids "$ids" >/dev/null || exit 1;; esac; done
```

New agent groups are not covered by these rules. Re-run `/add-zapier-tool`
after creating a group to grant or explicitly block it.

## Register Zapier for the selected groups

Register the fixed endpoint through NanoClaw's supported config interface.
Do not add headers: OneCLI injects the `Authorization` header in flight.
Re-running replaces the same named entry rather than creating a duplicate:

```nc:run effect:wire
for gid in $(printf '%s' '{{zapier_agents}}' | tr ',' ' '); do ncl groups config add-mcp-server --id "$gid" --name zapier --url https://mcp.zapier.com/api/v1/connect >/dev/null || exit 1; done
```

From inside a NanoClaw container, this write may return `approval-pending`.
Wait for the admin decision and follow-up before restarting or verifying.

## Restart only affected groups

Restart the selected groups and ask each fresh container to report discovery
without executing any Zapier action:

```nc:run effect:restart
for gid in $(printf '%s' '{{zapier_agents}}' | tr ',' ' '); do ncl groups restart --id "$gid" --message "Zapier MCP is configured. List the discovered Zapier MCP tool names only. Do not invoke any Zapier tool, enable an action, or change external state." >/dev/null || exit 1; done
```

## Verify safely

Inspect the selected groups' stored config. It must contain the fixed endpoint
and no `headers`, token, or credential-bearing query string:

```nc:run effect:check
for gid in $(printf '%s' '{{zapier_agents}}' | tr ',' ' '); do ncl groups config get --id "$gid"; done
```

Check each agent's discovery response. Zapier's current dynamic server normally
exposes meta-tools such as `inspect_zapier_actions`,
`execute_zapier_read_action`, and `execute_zapier_write_action`; do not hardcode
that list as a health requirement because Zapier owns it.

Offer one harmless, user-chosen read-only smoke test, such as listing upcoming
calendar events or looking up a record. State which connected app and action
will run and wait for approval. Do not use `enable_zapier_action`,
`execute_zapier_write_action`, or any action that sends, creates, updates,
deletes, purchases, or publishes during the smoke test.

## Troubleshooting

- **OneCLI dashboard is unreachable:** inspect `APP_URL` again and use the URL
  the operator normally opens. Run `/init-onecli` if the service is absent.
- **The secret metadata check returns nothing:** use the exact name `Zapier MCP`
  and host pattern `mcp.zapier.com`. Never diagnose this by printing values.
- **Zapier returns `401` or an auth error:** regenerate the connection token in
  Zapier, update the OneCLI dashboard secret, and restart selected groups. Do
  not put the replacement token in a command or URL.
- **Tools are missing:** confirm the `zapier` entry in the selected group's
  config, restart that group, and confirm the Zapier server has tools enabled.
- **A selected group gets `403 blocked_by_policy`:** re-run the skill; its old
  skill-owned block rule was not removed or the group selection changed.
- **An unselected group can reach Zapier:** it may have been created after the
  last run. Re-run the skill to synchronize block rules.
- **A read action fails:** reconnect that app in Zapier and check the server's
  enabled actions. A successful Zapier MCP call consumes tasks from the
  operator's Zapier plan.
- **A write requires confirmation:** stop and get explicit user approval for
  the exact external effect. Installing this skill does not pre-authorize app
  writes.

## Removal

See [REMOVE.md](REMOVE.md) for complete, idempotent rollback.

## References

- [NanoClaw: Give agents tools](https://docs.nanoclaw.dev/extend/tools)
- [NanoClaw: Credentials](https://docs.nanoclaw.dev/operate/credentials)
- [Zapier MCP quickstart](https://docs.zapier.com/mcp/get-started/quickstart)
- [Zapier MCP connections](https://docs.zapier.com/mcp/overview/how-connections-work)
