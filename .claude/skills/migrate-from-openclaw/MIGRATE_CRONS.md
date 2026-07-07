# Migrating OpenClaw Cron Jobs to NanoClaw v2 Tasks

This file is referenced by SKILL.md Phase 5 when cron jobs are detected.

## How tasks work in NanoClaw v2

There is no `scheduled_tasks` table and no `store/messages.db`. A v2 task is a
`messages_in` row with `kind='task'` living in a **session's** `inbound.db`
(under `data/v2-sessions/<agent-group>/<session>/inbound.db`). The row carries:

- `process_after` — ISO 8601 timestamp for the next run.
- `recurrence` — a cron expression for repeating tasks; `NULL` for one-shot.
- `content` — JSON `{ "prompt": "...", "script": "<optional pre-agent bash>" }`.
- `series_id` — stable handle linking every occurrence of a recurring task.

The host recurrence sweep (`src/modules/scheduling/recurrence.ts`, called each
60s tick from `src/host-sweep.ts`) finds completed rows that still carry a
`recurrence`, computes the next fire with `cron-parser` **in the user's
timezone** (`TIMEZONE` from `src/config.ts`), and clones a fresh pending row
forward. One-shot tasks are marked `completed` after running, never deleted.

Because `inbound.db` is host-owned and per-session, you do **not** write task
rows by hand. The supported path is to let the running agent create them
through its `schedule_task` MCP tool — the agent writes a system message, the
host's `schedule_task` delivery action (`src/modules/scheduling/actions.ts`)
inserts the `messages_in` row. So migrating crons means **handing the agent a
clear instruction per job and letting it call `schedule_task`**.

## OpenClaw Cron Job Format

Source: `<STATE_DIR>/cron/jobs.json` (from OpenClaw's `src/cron/types.ts`). If
the file format doesn't match what's described here, read the actual file and
adapt — OpenClaw may have changed its schema.

The jobs file is `{ version: 1, jobs: CronJob[] }`. Each job has:

- `id`, `name`, `description`, `enabled`, `deleteAfterRun`
- `schedule`: `{ kind: "cron", expr, tz? }` | `{ kind: "every", everyMs }` | `{ kind: "at", at }`
- `payload`: `{ kind: "agentTurn", message, model?, thinking?, timeoutSeconds? }` | `{ kind: "systemEvent", text }`
- `sessionTarget`: `"main"` | `"isolated"` | `"current"` | `"session:<id>"`
- `wakeMode`: `"next-heartbeat"` | `"now"`
- `delivery`: `{ mode: "none" | "announce" | "webhook", channel?, to?, threadId?, bestEffort? }`
- `failureAlert`: `{ after?, channel?, to?, cooldownMs? }` | `false`
- `state`: runtime state (nextRunAtMs, lastRunStatus, …)

## Schedule mapping (use the shipped transform)

`scripts/transform.ts` exports `mapCronToRecurrence`, which converts an
OpenClaw `schedule` into the v2 `{ processAfter, recurrence, notes }` shape:

- `kind:"cron"` → `recurrence = expr`; `processAfter` = next fire of `expr`
  (computed with `cron-parser` in the job's `tz`, falling back to the user's TZ).
- `kind:"at"` → one-shot; `recurrence = null`; `processAfter = at`.
- `kind:"every"` → v2 recurrence is cron-based, so a fixed interval is
  approximated as the nearest cron when it divides cleanly into minutes/hours
  (e.g. `everyMs: 900000` → `*/15 * * * *`); otherwise it's flagged in `notes`
  and left one-shot for you to set a cron by hand.

`payload.message` (agentTurn) or `payload.text` (systemEvent) becomes the task
`prompt`.

## What doesn't map

- `delivery.mode:"webhook"` — v2 has no webhook delivery. Fold the webhook into
  the task `prompt` ("…then POST the result to <url>") or a pre-agent `script`
  that `curl`s the endpoint.
- `delivery.mode:"announce"` / `channel` / `to` — a v2 task runs inside the
  session it was scheduled in and replies through that session's normal
  delivery path. Cross-channel announce isn't a task field; if the job targeted
  a different chat, schedule the task from the agent in *that* group.
- `failureAlert` — no failure-alert system. Note it to the user.
- `wakeMode` — v2 wakes a container when a task's `process_after` is due; there
  is no next-heartbeat vs now distinction.
- `payload.model` / `thinking` / `timeoutSeconds` — per-task model/thinking
  config isn't a task field. Per-group model lives in the container config
  (`ncl groups config update`).
- `deleteAfterRun` — v2 one-shot tasks become `completed`, not deleted.
- `sessionTarget` — `isolated` vs `main`/`current` selected a session in
  OpenClaw. In v2 the task lands in whichever session the agent schedules it
  from. Schedule from the group/DM whose session should own the task.

## For each enabled job

1. Show what it does: name, schedule, prompt, original delivery mode.
2. Run the schedule through `mapCronToRecurrence` and show the resulting
   `processAfter` / `recurrence`, plus any `notes` (interval approximation,
   webhook caveats).
3. Explain the differences (no failure alerts, webhook folded into the prompt,
   announce → runs in the scheduling session).
4. Ask whether to keep this task.

## Creating the task

Tasks are created **by the agent** via its `schedule_task` MCP tool, which is
why the agent group and its DM/group session must already exist (Phase 1) and
the service must be running. Hand the agent one instruction per kept job, e.g.:

> Schedule a recurring task: prompt = "Summarize my unread email and send me
> the digest.", recurrence = "0 9 * * 1-5", first run = "2026-06-09T09:00:00"
> (my local time).

The agent calls `schedule_task` with `prompt`, `processAfter` (ISO; a naive
local timestamp is interpreted in the user's timezone), `recurrence` (the cron
expression, or omitted for one-shot), and an optional `script`. The host
inserts the `messages_in` row and the recurrence sweep takes over.

To confirm afterwards, ask the agent to run `list_tasks`, or inspect the
session's inbound DB directly:

```bash
pnpm exec tsx scripts/q.ts \
  data/v2-sessions/<agent-group>/<session>/inbound.db \
  "SELECT series_id, status, process_after, recurrence FROM messages_in WHERE kind='task'"
```

If the agent group / session doesn't exist yet (Phase 1 deferred, or the
channel isn't installed), record the mapped tasks in the group's
`groups/<folder>/openclaw-migration-tasks.md` with prompt + processAfter +
recurrence per job, and tell the user the agent will schedule them on first run
once the channel is wired.
