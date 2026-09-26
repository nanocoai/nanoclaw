---
name: manage-schedules
description: List, add, modify, pause, resume, and cancel scheduled tasks across agent groups. Use when setting up recurring agent jobs, changing a cron schedule, or cancelling a task.
---

# Manage Schedules

Scheduled tasks are `messages_in` rows with `kind='task'` in the session's `inbound.db`. The host sweep (`src/host-sweep.ts`) fires them when `process_after <= now()` and advances `process_after` for recurring tasks.

**Prerequisite:** The target agent group must have at least one session (the agent must have received at least one message). If no session exists, tasks can't be inserted yet — send a message in the group's channel first.

## Assess Current State

```bash
# Step 1: list agent groups and their most recent sessions
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT ag.id AS group_id, ag.name, s.id AS session_id
  FROM agent_groups ag
  LEFT JOIN sessions s ON s.id = (
    SELECT id FROM sessions WHERE agent_group_id = ag.id ORDER BY created_at DESC LIMIT 1
  )
  ORDER BY ag.name
"

# Step 2: for each group that has a session, list its tasks
pnpm exec tsx scripts/q.ts \
  "data/v2-sessions/<group_id>/<session_id>/inbound.db" \
  "SELECT id, status, recurrence, process_after,
          substr(json_extract(content, '$.prompt'), 1, 80) AS prompt
   FROM messages_in WHERE kind='task' ORDER BY process_after"
```

Display summary per group: task ID, status (`pending`/`paused`/`completed`), recurrence (or "one-shot" if NULL), next fire time, prompt preview. Flag one-shot tasks separately from recurring ones.

## Add a New Task

Guide through these decisions:

**1. Which agent group** — pick from the list above; confirm session exists

**2. One-shot or recurring**
- One-shot: `recurrence = null`, `processAfter` is a specific ISO datetime
- Recurring: provide a cron expression. Common presets:
  - Daily 8am: `0 8 * * *`
  - Weekly Sunday 9am: `0 9 * * 0`
  - Every weekday 9am: `0 9 * * 1-5`
  - Thursday 6pm: `0 18 * * 4`

**3. Platform routing** — which channel the agent's response is sent to:
```bash
pnpm exec tsx scripts/q.ts data/v2.db "
  SELECT mg.platform_id, mg.channel_type, mg.name
  FROM messaging_group_agents mga
  JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
  WHERE mga.agent_group_id = '<group_id>'
"
```

**4. Prompt** — what the agent should do when the task fires

Write and run a temp script to insert:

```typescript
// tmp-insert-task.ts
import path from 'path';
import { initDb, getDb } from './src/db/index.js';
import { openInboundDb } from './src/session-manager.js';
import { insertTask } from './src/modules/scheduling/db.js';
import { TIMEZONE } from './src/config.js';
import { CronExpressionParser } from 'cron-parser';

const AGENT_GROUP_ID = '<group_id>';
const RECURRENCE = '0 8 * * *';          // set to null for one-shot
const PROMPT = 'Your task prompt here';
const PLATFORM_ID = '<platform_id>';
const CHANNEL_TYPE = '<channel_type>';    // e.g. 'telegram', 'whatsapp'

initDb(path.join(process.cwd(), 'data', 'v2.db'));
const db = getDb();
const session = db
  .prepare('SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY created_at DESC LIMIT 1')
  .get(AGENT_GROUP_ID) as { id: string } | undefined;
if (!session) throw new Error('No session — send a message in the group first');

const inDb = openInboundDb(AGENT_GROUP_ID, session.id);
const processAfter = RECURRENCE
  ? CronExpressionParser.parse(RECURRENCE, { tz: TIMEZONE }).next().toISOString()
  : new Date('<ISO datetime here>').toISOString();

insertTask(inDb, {
  id: `task-${Date.now()}`,
  processAfter,
  recurrence: RECURRENCE,
  platformId: PLATFORM_ID,
  channelType: CHANNEL_TYPE,
  threadId: null,
  content: JSON.stringify({ prompt: PROMPT, script: null }),
});
console.log('Task inserted, next run:', processAfter, `(${TIMEZONE})`);
```

```bash
pnpm exec tsx tmp-insert-task.ts && rm tmp-insert-task.ts
```

Reference: `scripts/setup-ally-cron.ts` is a full working example.

## Modify a Task

`updateTask` matches by `id OR series_id`, so it hits the live next occurrence of a recurring task — not the completed row the agent last saw.

```typescript
// tmp-update-task.ts
import path from 'path';
import { initDb, getDb } from './src/db/index.js';
import { openInboundDb } from './src/session-manager.js';
import { updateTask } from './src/modules/scheduling/db.js';
import { TIMEZONE } from './src/config.js';
import { CronExpressionParser } from 'cron-parser';

const AGENT_GROUP_ID = '<group_id>';
const TASK_ID = '<task_id_or_series_id>';
const NEW_RECURRENCE = '0 9 * * *';
const NEW_PROMPT = 'Updated prompt';

initDb(path.join(process.cwd(), 'data', 'v2.db'));
const db = getDb();
const session = db
  .prepare('SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY created_at DESC LIMIT 1')
  .get(AGENT_GROUP_ID) as { id: string } | undefined;
if (!session) throw new Error('No session found');

const inDb = openInboundDb(AGENT_GROUP_ID, session.id);
const processAfter = CronExpressionParser
  .parse(NEW_RECURRENCE, { tz: TIMEZONE }).next().toISOString();
const updated = updateTask(inDb, TASK_ID, {
  prompt: NEW_PROMPT,
  recurrence: NEW_RECURRENCE,
  processAfter,
});
console.log(`Updated ${updated} row(s), next run: ${processAfter}`);
```

```bash
pnpm exec tsx tmp-update-task.ts && rm tmp-update-task.ts
```

## Cancel a Task

`cancelTask` marks the task and all occurrences sharing its `series_id` as completed with no recurrence — it will never fire again.

```typescript
// tmp-cancel-task.ts
import path from 'path';
import { initDb, getDb } from './src/db/index.js';
import { openInboundDb } from './src/session-manager.js';
import { cancelTask } from './src/modules/scheduling/db.js';

const AGENT_GROUP_ID = '<group_id>';
const TASK_ID = '<task_id>';

initDb(path.join(process.cwd(), 'data', 'v2.db'));
const db = getDb();
const session = db
  .prepare('SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY created_at DESC LIMIT 1')
  .get(AGENT_GROUP_ID) as { id: string } | undefined;
if (!session) throw new Error('No session found');

cancelTask(openInboundDb(AGENT_GROUP_ID, session.id), TASK_ID);
console.log('Task cancelled');
```

```bash
pnpm exec tsx tmp-cancel-task.ts && rm tmp-cancel-task.ts
```

## Pause / Resume

Pausing stops the task from firing without removing it (`status='paused'`).

```typescript
import { pauseTask, resumeTask } from './src/modules/scheduling/db.js';
// Use same session lookup pattern, then:
pauseTask(inDb, TASK_ID);    // or
resumeTask(inDb, TASK_ID);
```

Same temp-script pattern as above; omit `NEW_RECURRENCE` and `processAfter`.

## Key Gotchas

- **Tasks live in the most recent session's `inbound.db`** — no session means no tasks yet; send a test message first
- **`series_id` is the stable identity for recurring tasks** — `updateTask` and `cancelTask` match `id OR series_id` to hit the live next occurrence, not the completed row the agent last saw
- **Don't compare `process_after` across runs for recurring tasks** — it advances after each fire; `recurrence` is the stable field
- **Missing `recurrence`** on an intended recurring task causes it to fire once and disappear — always verify the field is set after insertion

## Key Files

| File | Purpose |
|------|---------|
| `src/modules/scheduling/db.ts` | `insertTask`, `cancelTask`, `pauseTask`, `resumeTask`, `updateTask` |
| `src/host-sweep.ts` | Recurrence advancement and task wakeup logic |
| `scripts/setup-ally-cron.ts` | Reference implementation for task insertion |
| `container/agent-runner/src/db/messages-in.ts` | How the container reads tasks |
