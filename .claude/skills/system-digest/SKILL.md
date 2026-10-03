---
name: system-digest
description: Show current NanoClaw system state — agent groups, channels, wirings, scheduled tasks, and any pending alerts. On-demand view of what /setup-system-digest monitors daily.
---

# System Digest

Show the current NanoClaw system state. This is the on-demand counterpart to the daily digest delivered by the automated timer.

## Output

Query and display each section in order:

### Agent Groups

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT ag.name, ag.folder, cc.provider, cc.model, cc.cli_scope,
         cc.mcp_servers, cc.packages_apt, cc.packages_npm
  FROM agent_groups ag
  LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id
  ORDER BY ag.name
"
```

For each group show: name, folder, provider/model (note if inheriting global default), CLI scope, MCP server names, packages.

### Channels & Wirings

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT ag.name AS agent, mg.channel_type, mg.name AS channel,
         mga.session_mode, mg.unknown_sender_policy
  FROM messaging_group_agents mga
  JOIN agent_groups ag ON ag.id = mga.agent_group_id
  JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
  ORDER BY ag.name, mg.channel_type
"
```

### Scheduled Tasks

```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT ag.id AS group_id, ag.name, s.id AS session_id
  FROM agent_groups ag
  LEFT JOIN sessions s ON s.id = (
    SELECT id FROM sessions WHERE agent_group_id = ag.id ORDER BY created_at DESC LIMIT 1
  )
  ORDER BY ag.name
"
```

For each group with a session:
```bash
pnpm exec tsx scripts/q.ts \
  "data/v2-sessions/<group_id>/<session_id>/inbound.db" \
  "SELECT id, status, recurrence, process_after,
          substr(json_extract(content, '$.prompt'), 1, 60) AS prompt
   FROM messages_in WHERE kind='task' AND status != 'completed'
   ORDER BY process_after"
```

Show: task ID, recurrence pattern (human-readable), next fire time in local time, prompt preview. Group by agent. Note if a group has no tasks.

### Alerts

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT COUNT(*) FROM pending_approvals"
pnpm exec tsx scripts/q.ts data/v2.db "SELECT COUNT(*) FROM unregistered_senders"
```

Flag if either is non-zero.

### Last Digest Delivery

```bash
ls -lh data/system-digest.json 2>/dev/null || echo "No baseline snapshot yet — run /setup-system-digest"
```

Show when the baseline was last updated (last time something changed and was delivered).

## Format

Present output as a readable summary, not raw SQL rows. Use headers per section. Summarize rather than dump — one line per agent group, one line per wiring, etc. Highlight anything unusual: `cli_scope = 'global'` on any agent that is **not** the owner's primary agent (global scope is expected and correct for the owner agent), `unknown_sender_policy = 'public'` on group channels, overdue tasks, pending alerts.
