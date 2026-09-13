---
name: manage-agents
description: Create, update, reconfigure, and delete agent groups. Use when setting up a new agent, changing model or provider, adding MCP servers or packages, or removing an agent.
---

# Manage Agents

Manage agent groups — the logical agent identities in NanoClaw. For wiring agent groups to messaging channels, use `/manage-channels`.

## Assess Current State

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT ag.id, ag.name, ag.folder,
         cc.provider, cc.model, cc.cli_scope,
         cc.mcp_servers, cc.packages_apt, cc.packages_npm
  FROM agent_groups ag
  LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id
  ORDER BY ag.name
"
```

Highlight what's notable:
- `model` is NULL → inherits global default from `.env` (`OPENCODE_MODEL` / `CLAUDE_MODEL`)
- `cli_scope = 'global'` → unrestricted — agent can modify any group, wiring, or user
- No row in `messaging_group_agents` → agent won't receive messages until wired via `/manage-channels`
- `provider` is NULL → inherits from `.env` global default

## Create a New Agent Group

Guide through these decisions in order:

**1. Name + folder**
- Name: display label in logs and help output; need not be unique
- Folder: directory name under `groups/` on the host; must be unique; cannot change after creation

```bash
ncl groups create --name "<name>" --folder "<folder>"
```

**2. Provider + model** (optional — defaults to `.env` global)

```bash
ncl groups config update --id <id> --provider <provider> --model <model>
```

Built-in providers: `claude` (Anthropic Agent SDK default), `opencode` (reads `OPENCODE_MODEL` from `.env`). To use a non-default provider the install step must have been run first (e.g. `/add-opencode`, `/add-codex`).

**3. CLI scope** (only raise if this is an owner or admin agent)
- `group` (default): scoped to own group — sessions, members, destinations only
- `global`: unrestricted. Only grant to owner agents.

```bash
ncl groups config update --id <id> --cli-scope global
```

**4. Personality**
After creation, offer to open the group's CLAUDE.md to set personality and instructions:
```
groups/<folder>/CLAUDE.md
```

**5. Wire a channel**
Delegate to `/manage-channels` for the wiring step.

## Update an Existing Agent Group

**Model or provider:**
```bash
ncl groups config update --id <id> --model <model>
ncl groups config update --id <id> --provider <provider>
```
Requires restart to take effect: `ncl groups restart --id <id>`

**Personality** — edit `groups/<folder>/CLAUDE.md` directly. Changes apply on the next container start; restart to apply immediately:
```bash
ncl groups restart --id <id>
```

**Restart with instructions for the fresh container:**
```bash
ncl groups restart --id <id> --message "Verify your new tools are working and let the user know."
```

## MCP Servers

**Add (command-based):**
```bash
ncl groups config add-mcp-server --id <id> \
  --name <name> \
  --command <cmd> \
  --args '["<arg1>", "<arg2>"]' \
  --env '{"KEY": "value"}'
```

**Add (SSE URL):**
```bash
ncl groups config add-mcp-server --id <id> --name <name> --url <url>
```

**Remove:**
```bash
ncl groups config remove-mcp-server --id <id> --name <name>
```

Key guidance:
- Secrets belong in `.env` and should be referenced by env var name in `--env` — never hardcode credentials in the DB
- Test SSE URL reachability before wiring: `curl <url>`
- Requires `ncl groups restart --id <id>` to take effect

## Packages

```bash
ncl groups config add-package --id <id> --apt <pkg>
ncl groups config add-package --id <id> --npm <pkg>
ncl groups config remove-package --id <id> --apt <pkg>
ncl groups config remove-package --id <id> --npm <pkg>
```

Requires `ncl groups restart --id <id> --rebuild` (rebuilds the container image).

## Delete an Agent Group

```bash
ncl groups delete --id <id>
```

Warn before running:
- `groups/<folder>/` is **not** removed — offer to delete manually: `rm -rf groups/<folder>`
- Session data in `data/v2-sessions/<id>/` stays behind — safe to leave as archive or remove manually
- Wirings are cascade-deleted, but `agent_destinations` rows in other groups that target this one as a named destination are **not** cleaned up automatically
- Kill any running container first so it doesn't write to the now-deleted group's DB

## Key Files

| File | Purpose |
|------|---------|
| `src/db/container-configs.ts` | CRUD for `container_configs` |
| `src/group-init.ts` | Filesystem scaffold for new groups |
| `src/cli/resources/` | ncl verb implementations |
| `docs/isolation-model.md` | CLI scope explanation |
