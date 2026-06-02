# Migrating OpenClaw Cron Jobs to NanoClaw Scheduled Tasks

This file is referenced by SKILL.md Phase 5 when cron jobs are detected.

**Before inserting tasks:** Read `src/db.ts` and search for `scheduled_tasks` to verify the current table schema. The schema below is a reference — if columns have been added, removed, or renamed, use the current schema from the source code.

Also verify the `createTask` function signature in `src/db.ts` — it may be simpler to call it via a script than raw SQL.

## OpenClaw Cron Job Format

Source: `<STATE_DIR>/cron/jobs.json` (from `src/cron/types.ts`). If the file format doesn't match what's described below, read the actual file and adapt — OpenClaw may have changed the schema.

The jobs file is `{ version: 1, jobs: CronJob[] }`. Each job has:
- `id`, `name`, `description`, `enabled`, `deleteAfterRun`
- `schedule`: `{ kind: "cron", expr: string, tz?: string }` | `{ kind: "every", everyMs: number }` | `{ kind: "at", at: string }`
- `payload`: `{ kind: "agentTurn", message: string, model?, thinking?, timeoutSeconds? }` | `{ kind: "systemEvent", text: string }`
- `sessionTarget`: `"main"` | `"isolated"` | `"current"` | `"session:<id>"`
- `wakeMode`: `"next-heartbeat"` | `"now"`
- `delivery`: `{ mode: "none" | "announce" | "webhook", channel?, to?, threadId?, bestEffort? }`
- `failureAlert`: `{ after?: number, channel?, to?, cooldownMs? }` | `false`
- `state`: runtime state (nextRunAtMs, lastRunStatus, consecutiveErrors, etc.)

## NanoClaw `scheduled_tasks` Table

Source: `src/db.ts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Unique task ID |
| `group_folder` | TEXT | Target group directory (e.g. `"main"`) |
| `chat_jid` | TEXT | Target chat JID |
| `prompt` | TEXT | Task instructions |
| `script` | TEXT | Optional bash pre-check script |
| `schedule_type` | TEXT | `"cron"`, `"interval"`, or `"once"` |
| `schedule_value` | TEXT | Cron expr, ms interval, or ISO timestamp |
| `context_mode` | TEXT | `"group"` or `"isolated"` (default) |
| `next_run` | TEXT | ISO timestamp — must be computed at insert time |
| `last_run` | TEXT | null initially |
| `last_result` | TEXT | null initially |
| `status` | TEXT | `"active"`, `"paused"`, or `"completed"` |
| `created_at` | TEXT | ISO timestamp |

## Field Mapping

- `schedule.kind:"cron"` + `schedule.expr` → `schedule_type:"cron"`, `schedule_value:<expr>`
- `schedule.kind:"every"` + `schedule.everyMs` → `schedule_type:"interval"`, `schedule_value:<ms as string>`
- `schedule.kind:"at"` + `schedule.at` → `schedule_type:"once"`, `schedule_value:<ISO timestamp>`
- `payload.message` or `payload.text` → `prompt`
- `sessionTarget:"isolated"` → `context_mode:"isolated"`, `sessionTarget:"main"` or `"current"` → `context_mode:"group"`

## What Doesn't Map

- `delivery.mode:"webhook"` — NanoClaw has no webhook delivery. Discuss with the user: this could be implemented as a task `script` that runs `curl` to hit the webhook endpoint.
- `failureAlert` — NanoClaw has no failure alert system. Note this to the user.
- `wakeMode` — NanoClaw tasks always wake the agent immediately.
- `payload.model`, `payload.thinking`, `payload.timeoutSeconds` — NanoClaw doesn't support per-task model/thinking config. These are handled by the SDK.
- `deleteAfterRun` — NanoClaw `"once"` tasks are marked `"completed"` after running, not deleted.

## For Each Enabled Job

1. Show what it does: name, schedule, prompt, delivery mode
2. Explain any differences (no retry config, no webhook delivery, no failure alerts)
3. If `delivery.mode:"webhook"`: discuss with the user — a task `script` with `curl` often suffices
4. Ask if they want to keep this task

## Inserting Tasks

Insert directly into the SQLite database. This requires groups to be registered first (Phase 1). Use the registered group's `folder` and `chat_jid`:

```bash
pnpm exec tsx -e "
const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');
const db = new Database('store/messages.db');
// Compute next_run for cron tasks:
// const interval = CronExpressionParser.parse('<expr>', { tz: process.env.TZ || 'UTC' });
// const nextRun = interval.next().toISOString();
db.prepare(\`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).run(
  'migrated-<original-id>',
  '<group_folder>',
  '<chat_jid>',
  '<mapped prompt>',
  null,
  '<mapped schedule_type>',
  '<mapped schedule_value>',
  '<mapped context_mode>',
  '<computed next_run ISO>',
  'active',
  new Date().toISOString()
);
db.close();
"
```

**Computing `next_run`:**
- `cron` tasks: use `CronExpressionParser.parse(expr, { tz }).next().toISOString()`
- `interval` tasks: `new Date(Date.now() + ms).toISOString()`
- `once` tasks: `next_run` equals `schedule_value`

If groups haven't been registered yet (database doesn't exist), save the task details to `groups/main/openclaw-migration-tasks.md` with the exact SQL payloads, and tell the user: "These tasks will be created after `/setup` registers your groups."
