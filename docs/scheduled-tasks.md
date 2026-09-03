# Scheduled Tasks

Scheduled tasks run an agent prompt at a future time or on a recurring cron
schedule. Each task belongs to an agent group and runs in its own system
session, separate from normal chat sessions.

Run `ncl tasks create --help` for the complete and current CLI reference.

## Create a recurring task

From the host, pass the agent group that should own the task:

```bash
ncl tasks create \
  --group <agent-group-id> \
  --name "weekday briefing" \
  --recurrence "0 9 * * 1-5" \
  --prompt "Prepare the weekday briefing and send it to telegram"
```

The first run is calculated from the cron schedule. Cron expressions use the
NanoClaw installation timezone.

Inside an agent container, `--group` is filled in automatically with that
agent's group.

## Create a one-time task

One-time tasks use `--process-after` instead of `--recurrence`:

```bash
ncl tasks create \
  --group <agent-group-id> \
  --name "call reminder" \
  --process-after "2026-07-14T18:00:00+03:00" \
  --prompt "Remind me to call Dana"
```

`--process-after` accepts an ISO 8601 timestamp or a local time interpreted in
the installation timezone.

## Delivery and run logs

A scheduled task has no chat attached to it. If its result should reach a
user, the prompt must tell the agent where to send it. Use a destination name
available to that agent, such as `telegram` or `team-slack`.

NanoClaw also asks the agent to append a short work-log entry after each agent
run. View run counts, failures, and recent log entries with:

```bash
ncl tasks get <task-id> --group <agent-group-id>
```

## Manage and test tasks

```bash
ncl tasks list --group <agent-group-id>
ncl tasks update <task-id> --group <agent-group-id> --prompt "New prompt"
ncl tasks pause <task-id> --group <agent-group-id>
ncl tasks resume <task-id> --group <agent-group-id>
ncl tasks cancel <task-id> --group <agent-group-id>
ncl tasks delete <task-id> --group <agent-group-id>
```

`cancel` stops the live task but keeps its history. `delete` permanently removes
the whole task series and its history.

To test a task immediately without changing its schedule:

```bash
ncl tasks run <task-id> --group <agent-group-id>
```

`run` also works while a task is paused. It queues one extra run and does not
resume the recurring schedule.

## Script gates

A task can run a Bash script before waking the agent. This is useful for
frequent checks where most runs have nothing for the agent to do.

The script's last line of standard output must be JSON:

```json
{ "wakeAgent": false }
```

or:

```json
{ "wakeAgent": true, "data": { "alerts": 2 } }
```

- `wakeAgent: false` completes the run without calling the model.
- `wakeAgent: true` wakes the agent and adds `data` to its prompt.

Scripts run with Bash, a 30-second timeout, and a 1 MB output limit. The JSON
decision must be the final line written to standard output. Keep `data` small
and include only what the agent needs.

For example, save this as `check-marker.sh`:

```bash
marker=/workspace/agent/wake-next-task

if [ -f "$marker" ]; then
  rm -f "$marker"
  echo '{"wakeAgent": true, "data": {"reason": "marker found"}}'
else
  echo '{"wakeAgent": false}'
fi
```

Test it before scheduling, then pass its contents to `ncl`:

```bash
bash check-marker.sh

ncl tasks create \
  --group <agent-group-id> \
  --name "marker check" \
  --recurrence "*/15 * * * *" \
  --prompt "Handle the condition reported by the script" \
  --script "$(cat check-marker.sh)"
```

Store state that must survive between runs under `/workspace/agent`, the agent
group workspace.

Avoid putting secrets directly in task scripts. Prefer runtime credential
injection through OneCLI so credentials are not stored in the task definition.

## Frequency limit

An ungated recurring task that would fire more than four times in the next 24
hours is rejected. A task with a script gate is allowed to run more often
because `wakeAgent: false` uses no model tokens.

For an intentionally frequent task that has no script, see the explicit
override in `ncl tasks create --help` and confirm the token and quota cost
before using it.

## Script failures

A timeout, nonzero exit, missing decision, or invalid JSON counts as a failed
run. Consecutive failures delay the next recurring run by 2, 4, 8, 16, 32,
then 60 minutes. Further failures stay at the 60-minute delay.

After eight consecutive failures, NanoClaw pauses the series and writes the
reason to its run log. Fix the script, test it, then resume the task:

```bash
ncl tasks resume <task-id> --group <agent-group-id>
```

A valid `wakeAgent: false` decision is a successful run. It does not trigger
failure backoff.

## Template tasks

Agent templates can include recurring tasks and optional script gates. Template
tasks are created paused so installing a template never starts background work
without approval. See [Agent Templates](templates.md#recurring-tasks).

For implementation details, see
[Pre-Agent Scripts](agent-runner-details.md#pre-agent-scripts-tasks).
