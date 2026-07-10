## Admin CLI (`ncl`)

The `ncl` command is available at `/usr/local/bin/ncl`. It lets you query and modify NanoClaw's central configuration.

### Usage

```
ncl <resource> <verb> [--flags]
ncl <resource> help
ncl help
```

### Scope

Your CLI access may be scoped. Run `ncl help` to see which resources are available and whether args are auto-filled. Under `group` scope (the default), `--id` and group-related args are auto-filled to your agent group — you don't need to pass them.

### Resources

Run `ncl help` for the full list. Common resources:

| Resource     | Verbs                                                                                                                                     | What it is                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| groups       | list, get, create, update, delete, restart, config get/update, config add-mcp-server/remove-mcp-server, config add-package/remove-package | Agent groups (workspace, personality, container config) |
| sessions     | list, get                                                                                                                                 | Active sessions (read-only)                             |
| destinations | list, add, remove                                                                                                                         | Where an agent group can send messages                  |
| members      | list, add, remove                                                                                                                         | Unprivileged access gate for an agent group             |
| tasks        | list, get, create, update, cancel, pause, resume, delete, append-log                                                                      | Scheduled tasks for your agent group                    |

Additional resources (available under `global` scope only): messaging-groups, wirings, users, roles, user-dms, dropped-messages, approvals.

### When to use

- **Looking up your own config** — `ncl groups get` or `ncl groups config get` to see your container config.
- **Restarting your container** — `ncl groups restart` (with optional `--rebuild` and `--message`).
- **Checking who's in your group** — `ncl members list`.
- **Seeing your destinations** — `ncl destinations list`.
- **Scheduling work** — `ncl tasks create`, then `ncl tasks list/get/update/cancel/pause/resume/delete`; `ncl tasks run <id>` fires one extra run now (testing) without changing the schedule. At the end of each task run, `ncl tasks append-log --msg "…"` to record what happened (host-timestamped, not a message).
- **Answering questions about the system** — query `ncl` rather than guessing.

### Access rules

Read commands (list, get) are open. Most write commands (create, update, delete, restart, config update, add, remove) require admin approval — the request is held until an admin approves it. `ncl tasks` is the exception: an agent can manage its own group tasks without approval.

### Approval flow

Write commands require admin approval. Here's what happens:

1. You run the command (e.g. `ncl groups config update --model claude-sonnet-4-5-20250514`).
2. The command returns immediately with an `approval-pending` response — it has **not** been executed yet.
3. An admin or owner gets a notification showing exactly what you requested, with approve/reject options.
4. Once the admin responds:
   - **Approved:** the command executes and the result is delivered back to you as a system message in this conversation.
   - **Rejected:** you get a system message saying the request was rejected.

You don't need to poll or retry — the result arrives automatically.

### Examples

```bash
# Read commands (no approval needed)
ncl groups get
ncl groups config get
ncl sessions list
ncl destinations list
ncl members list
ncl tasks list
# Always pass a short descriptive --name so the task id is readable (e.g. daily-briefing-a25c, not a long uuid).
# For a recurring task, --recurrence alone sets the schedule (first run derived from it); add --process-after only for one-shots.
ncl tasks create --name "daily briefing" --prompt "Send the daily briefing" --recurrence "0 9 * * *"
# At the END of every task run, record one line of history. The host stamps the local time — you supply only the summary.
# This is a LOG ENTRY, not a message: it sends nothing to anyone. Inside a task fire --id is auto-derived from your session.
ncl tasks append-log --msg "posted the daily digest to slack; one feed returned 403, skipped"

# Write commands (approval required)
ncl groups restart
ncl groups restart --rebuild --message "Config updated."
ncl groups config update --model claude-sonnet-4-5-20250514
ncl groups config add-mcp-server --name rss --command npx --args '["some-rss-mcp"]'
ncl groups config add-package --npm some-package
ncl members add --user telegram:jane
```

### Important

Config changes via `ncl groups config update` do not take effect until `ncl groups restart`. Run `ncl groups config help` for details.

### Tips

- Use `ncl <resource> help` to see all available fields, types, enums, and which fields are auto-filled.
- Flags use `--hyphen-case` (e.g. `--agent-group-id`), mapped to `underscore_case` DB columns automatically.
- `list` supports filtering by any non-auto column. Default limit is 200 rows; override with `--limit N`.
- Write commands return `approval-pending` immediately — don't treat this as an error. Wait for the system message with the result.
