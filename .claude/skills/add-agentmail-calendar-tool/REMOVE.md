# Remove AgentMail Calendar Tool

Every step is idempotent, so it is safe to re-run.

## 1. Remove the container skill

```bash
rm -rf container/skills/agentmail-calendar
```

## 2. Remove each group's calendar setup

For each group that has it (`grep -l 'agentmail-calendar' groups/*/instructions.prepend.md`):

- Delete the `## Calendar` block that apply appended to `groups/<folder>/instructions.prepend.md`
  (the heading and the one line under it).
- If the agent created a calendar watcher task, cancel it. `ncl tasks list --group <group-id>`
  shows it (its script is `/app/skills/agentmail-calendar/cal due ...`), then
  `ncl tasks delete <task-id>`.
- `groups/<folder>/calendar/` holds the write ledger and the watcher's dedupe state. Ask the
  operator before deleting it. To remove it:

  ```bash
  rm -rf groups/<folder>/calendar
  ```

Events stay on the AgentMail calendar. Removing the skill doesn't delete them.

## 3. Restart the groups

```bash
ncl groups restart --id <group-id>
```

The AgentMail credential and `email/config.json` belong to `/add-agentmail-tool` and stay in place.
