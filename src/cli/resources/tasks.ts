import fs from 'fs';

import { GROUPS_DIR, TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  deleteSession,
  findTaskSessions,
  getActiveSessions,
  getSession,
  isTaskThread,
  taskThreadId,
  TASKS_SYSTEM_THREAD_ID,
} from '../../db/sessions.js';
import type { TaskUpdate } from '../../mailbox/index.js';
import { parseTaskContent } from '../../modules/scheduling/task-content.js';
import {
  createScheduledTask,
  enforceRecurrenceLimit,
  makeTaskId,
  MAX_DAILY_FIRES,
  parseProcessAfter,
  prepareScheduledTask,
  type ScheduledTaskRow,
  validateRecurrence,
} from '../../modules/scheduling/create.js';
import { destroySessionMailbox, sessionDir, withExistingMailboxSession } from '../../session-manager.js';
import { registerResource } from '../crud.js';
import { appendRunLog, deleteRunLog } from '../../modules/scheduling/run-log.js';
import { formatTasksTable } from '../format-tasks.js';
import type { CallerContext } from '../frame.js';
import type { InboundMailbox } from '../../mailbox/index.js';
import { isContainerRunning } from '../../container-runner.js';

type TaskStatus = 'pending' | 'paused';

type TaskRow = ScheduledTaskRow;

interface ScopedSession {
  id: string;
  agent_group_id: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return String(value);
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'none') return null;
  return value;
}

function statusFilter(args: Record<string, unknown>): TaskStatus | undefined {
  const status = str(args.status);
  if (!status) return undefined;
  if (status !== 'pending' && status !== 'paused') {
    throw new Error('--status must be pending or paused');
  }
  return status;
}

function groupArg(args: Record<string, unknown>, ctx: CallerContext): string | undefined {
  if (ctx.caller === 'agent') return ctx.agentGroupId;
  return str(args.group) ?? str(args.agent_group_id);
}

async function ownSession(sessionId: string, ctx: CallerContext): Promise<ScopedSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (ctx.caller === 'agent' && session.agent_group_id !== ctx.agentGroupId) {
    throw new Error(`session not found: ${sessionId}`);
  }
  return { id: session.id, agent_group_id: session.agent_group_id };
}

async function selectedSessions(
  args: Record<string, unknown>,
  ctx: CallerContext,
  includeClosed = false,
): Promise<ScopedSession[]> {
  const sessionId = str(args.session);
  if (sessionId) return [await ownSession(sessionId, ctx)];

  const group = groupArg(args, ctx);
  if (group) {
    // One session per live task series — the loops below already fan out across them.
    return (await findTaskSessions(group, includeClosed)).map((s) => ({
      id: s.id,
      agent_group_id: s.agent_group_id,
    }));
  }

  if (ctx.caller === 'agent') return [];
  return (await getActiveSessions()).map((s) => ({ id: s.id, agent_group_id: s.agent_group_id }));
}

function withInbound<T>(session: ScopedSession, fn: (mailbox: InboundMailbox) => T): Promise<T | undefined> {
  return withExistingMailboxSession(session.agent_group_id, session.id, fn);
}

function toOutput(session: ScopedSession, row: TaskRow) {
  const content = parseTaskContent(row.content);
  return {
    agent_group_id: session.agent_group_id,
    session_id: session.id,
    series_id: row.seriesId ?? row.id,
    row_id: row.id,
    status: row.status,
    process_after: row.processAfter,
    recurrence: row.recurrence,
    prompt: content.prompt.length > 120 ? content.prompt.slice(0, 117) + '...' : content.prompt,
    has_script: content.script ? 1 : 0,
    origin_session_id: content.originSessionId, // which session created the task (null for CLI-created)
    created_at: row.timestamp,
    tries: row.tries,
  };
}

function selectLiveTasks(mailbox: InboundMailbox, status?: TaskStatus): TaskRow[] {
  return mailbox.listLiveTasks(status);
}

function selectTask(mailbox: InboundMailbox, id: string): TaskRow | undefined {
  return mailbox.getTask(id);
}

function taskId(args: Record<string, unknown>): string {
  const id = str(args.id);
  if (!id) throw new Error('task series id is required');
  return id;
}

async function createTask(args: Record<string, unknown>, ctx: CallerContext) {
  const group = groupArg(args, ctx);
  if (!group) throw new Error('--group is required');
  const prompt = str(args.prompt);
  if (!prompt) throw new Error('--prompt is required');
  const recurrence = normalizeNullableString(args.recurrence) ?? null;
  const script = normalizeNullableString(args.script) ?? null;
  const prepared = prepareScheduledTask({
    name: str(args.name),
    prompt,
    recurrence,
    processAfter: str(args.process_after),
    script,
    dangerouslyOverrideRecurrenceLimit: bool(args.dangerously_override_recurrence_limit),
    timezone: await resolveGroupTimezone(group),
  });
  const { session, row } = await createScheduledTask(group, prepared, {
    originSessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
  });
  return toOutput(session, row);
}

/**
 * Append one host-timestamped line to a task's run log
 * (`<GROUPS_DIR>/<folder>/tasks/<series>.md`). This is NOT a delivery — it writes
 * nothing to messages_out; it just records what happened so the agent (and human)
 * can see when and why each run happened. Inside a task run the series is derived from
 * the caller's own task session, so the agent supplies only --msg.
 */
async function appendTaskLog(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ series: string; timestamp: string; path: string; ok: true }> {
  const msg = str(args.msg);
  if (!msg) throw new Error('--msg is required');

  let series = str(args.id);
  let group = groupArg(args, ctx);
  if (!series && ctx.caller === 'agent' && ctx.sessionId) {
    const sess = await getSession(ctx.sessionId);
    if (sess && sess.thread_id && isTaskThread(sess.thread_id)) {
      series = sess.thread_id.slice(`${TASKS_SYSTEM_THREAD_ID}:`.length);
      group ??= sess.agent_group_id;
    }
  }
  if (!series) throw new Error('--id is required (no task session to derive it from)');
  if (!group) throw new Error('could not resolve the agent group');

  // Group scope is enforced by groupArg (a cli_scope=group caller can only
  // ever resolve its own folder), so a foreign id at worst writes a stray log
  // under the caller's OWN folder — no leak. appendRunLog guards the charset.
  return { ...(await appendRunLog(group, series, msg)), ok: true };
}

/**
 * Run history for one task series, aggregated over its occurrence rows: number
 * of successful fires, the last fire time, and failed fires (a row reaches
 * `failed` after MAX_TRIES on a stuck claim). Cancelled occurrences are
 * `cancelled`, not `completed`, so they never inflate the run count.
 */
function seriesStats(
  mailbox: InboundMailbox,
  seriesKey: string,
): { runs: number; lastRun: string | null; failedRuns: number } {
  return mailbox.getTaskStats(seriesKey);
}

/** Last ~10 lines of a series' run log (`tasks/<series>.md`), newest last. */
async function tailRunLog(agentGroupId: string, seriesKey: string, lines = 10): Promise<string[]> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return [];
  const file = `${GROUPS_DIR}/${ag.folder}/tasks/${seriesKey}.md`;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).slice(-lines);
}

/**
 * A task series is CronJob-like: the live (pending/paused) row is the next run,
 * and the `completed` rows are its run history. Enrich each listed series with
 * that history — run count, failures, last fire, next fire, schedule, and a
 * pointer to the agent's own run log — so `tasks list` reads as a compact
 * run-history table.
 */
function enrichListRow(db: InboundMailbox, base: ReturnType<typeof toOutput>) {
  const seriesKey = base.series_id;
  const stats = seriesStats(db, seriesKey);
  return {
    ...base,
    schedule: base.recurrence ?? 'once',
    runs: stats.runs,
    failed_runs: stats.failedRuns,
    last_run: stats.lastRun,
    next_run: base.process_after,
    log: `tasks/${seriesKey}.md`,
  };
}

async function listTasks(args: Record<string, unknown>, ctx: CallerContext) {
  const status = statusFilter(args);
  const rows = [];
  for (const session of await selectedSessions(args, ctx)) {
    const sessionRows = await withInbound(session, (db) =>
      selectLiveTasks(db, status).map((row) => enrichListRow(db, toOutput(session, row))),
    );
    if (sessionRows) rows.push(...sessionRows);
  }
  return rows;
}

async function getTask(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  for (const session of await selectedSessions(args, ctx)) {
    const found = await withInbound(session, (db) => {
      const row = selectTask(db, id);
      if (!row) return undefined;
      const seriesKey = row.seriesId ?? row.id;
      const stats = seriesStats(db, seriesKey);
      const content = parseTaskContent(row.content);
      return {
        ...toOutput(session, row),
        prompt: content.prompt,
        script: content.script,
        origin_session_id: content.originSessionId,
        completed_runs: stats.runs,
        failed_runs: stats.failedRuns,
        series_key: seriesKey,
      };
    });
    if (found) {
      const { series_key, ...output } = found;
      return { ...output, recent_log: await tailRunLog(session.agent_group_id, series_key) };
    }
  }
  throw new Error(`task not found: ${id}`);
}

async function mutateTask(
  args: Record<string, unknown>,
  ctx: CallerContext,
  fn: (db: InboundMailbox, id: string) => number,
) {
  const id = taskId(args);
  let touched = 0;
  for (const session of await selectedSessions(args, ctx)) {
    touched += (await withInbound(session, (db) => fn(db, id))) ?? 0;
  }
  if (touched === 0) throw new Error(`no live task matched: ${id}`);
  return { series_id: id, touched };
}

async function deleteTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  let touched = 0;
  for (const session of await selectedSessions(args, ctx, true)) {
    const found = await withInbound(session, (mailbox) => mailbox.getTask(id));
    if (!found) continue;
    if (isContainerRunning(session.id))
      throw new Error(`task is running; wait for it to finish before deleting: ${id}`);

    // Current tasks own an isolated session, so hard-delete the whole mailbox:
    // inbound history, outbound acknowledgements/messages, attachments, and heartbeat.
    // Clean up mailbox state before deleting the task so failures can be retried.
    if ((await getSession(session.id))?.thread_id === taskThreadId(id)) {
      await destroySessionMailbox(session.agent_group_id, session.id);
      fs.rmSync(sessionDir(session.agent_group_id, session.id), { recursive: true, force: true });
      await deleteSession(session.id);
      await deleteRunLog(session.agent_group_id, id);
      touched += 1;
      continue;
    }

    // Legacy shared task sessions may contain other series and keep their mailbox.
    const deleted = (await withInbound(session, (mailbox) => mailbox.deleteTask(id))) ?? 0;
    if (deleted === 0) continue;
    touched += deleted;
    await deleteRunLog(session.agent_group_id, id);
  }
  if (touched === 0) throw new Error(`no task matched: ${id}`);
  return { series_id: id, touched };
}

async function updateTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  const update: TaskUpdate = {};
  if (typeof args.prompt === 'string') update.prompt = args.prompt;
  const recurrence = normalizeNullableString(args.recurrence);
  const script = normalizeNullableString(args.script);

  // Wall-clock fields (--process-after, cron grid) are interpreted in the
  // owning group's timezone, so the task's group must be resolved before
  // parsing. The same lookup yields the task's current script for the
  // recurrence-limit check.
  let ownerGroup: string | undefined;
  let currentScript: string | null = null;
  if (args.process_after !== undefined || recurrence !== undefined) {
    for (const session of await selectedSessions(args, ctx)) {
      const row = await withInbound(session, (db) => selectTask(db, id));
      if (row) {
        ownerGroup = session.agent_group_id;
        currentScript = parseTaskContent(row.content).script;
        break;
      }
    }
  }
  const tz = ownerGroup ? await resolveGroupTimezone(ownerGroup) : TIMEZONE;

  if (args.process_after !== undefined) update.processAfter = parseProcessAfter(args.process_after, tz);
  if (recurrence !== undefined) {
    validateRecurrence(recurrence, tz);
    // Effective script AFTER this update: the new value when provided
    // (including an explicit clear), else whatever the task already has.
    const scriptAfter: string | null = script !== undefined ? script : currentScript;
    enforceRecurrenceLimit(recurrence, bool(args.dangerously_override_recurrence_limit), scriptAfter != null, tz);
    update.recurrence = recurrence;
  }
  if (script !== undefined) update.script = script;
  const fields = Object.keys(update);
  if (fields.length === 0) throw new Error('nothing to update');

  let touched = 0;
  for (const session of await selectedSessions(args, ctx)) {
    touched += (await withInbound(session, (mailbox) => mailbox.updateTask(id, update))) ?? 0;
  }
  if (touched === 0) throw new Error(`no live task matched: ${id}`);
  return { series_id: id, touched, fields };
}

async function cancelTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  if (!bool(args.all)) {
    return mutateTask(args, ctx, (mailbox, id) => mailbox.cancelTask(id));
  }

  let touched = 0;
  for (const session of await selectedSessions(args, ctx)) {
    touched += (await withInbound(session, (mailbox) => mailbox.cancelTask())) ?? 0;
  }
  return { cancelled: touched };
}

/**
 * `ncl tasks run <id>` — fire a task on demand without disturbing its schedule.
 * Inserts a fresh pending occurrence (same series, content, no recurrence) due
 * now, which the next sweep delivers through the normal fire path. Unlike
 * `update --process-after now`, it neither consumes a one-shot nor force-advances
 * a recurring series' armed occurrence, so it is safe for testing a task.
 */
async function runTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  for (const session of await selectedSessions(args, ctx)) {
    const fired = await withInbound(session, async (db) => {
      const row = selectTask(db, id);
      if (!row) return undefined;
      const seriesKey = row.seriesId ?? row.id;
      const rowId = makeTaskId(`${seriesKey}-run`);
      // recurrence=NULL is load-bearing: a run-now row must not be re-armed by
      // handleRecurrence into a phantom series.
      await db.insertTask({
        id: rowId,
        seriesId: seriesKey,
        processAfter: new Date().toISOString(),
        recurrence: null,
        content: row.content,
      });
      return { series_id: seriesKey, row_id: rowId, status: 'pending' };
    });
    if (fired) return fired;
  }
  throw new Error(`task not found: ${id}`);
}

registerResource({
  name: 'task',
  plural: 'tasks',
  table: 'messages_in',
  description:
    'Scheduled task — prompt plus run time. Tasks run from the agent group system session and the agent chooses delivery destination at fire time.',
  idColumn: 'series_id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'series_id', type: 'string', description: 'Stable task handle.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group that owns the task.' },
    { name: 'session_id', type: 'string', description: 'System session that runs the task.' },
    { name: 'status', type: 'string', description: 'Live state.', enum: ['pending', 'paused'] },
    {
      name: 'process_after',
      type: 'string',
      // Not flagged required: with --recurrence the first run is derived from the
      // cron grid (firstRunIso). Required only for one-shots, enforced in the
      // create handler — so the generic col.required validator must stay off here.
      description:
        'Next run time (ISO 8601 or naive local). Required for one-shots; with --recurrence the first run is derived from the cron grid.',
      updatable: true,
    },
    { name: 'recurrence', type: 'string', description: 'Optional cron expression.', updatable: true },
    { name: 'prompt', type: 'string', description: 'Task prompt.', required: true, updatable: true },
    { name: 'script', type: 'string', description: 'Optional pre-task bash script.', updatable: true },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List live tasks with per-series run history (schedule, runs, failures, next fire).',
      args: [
        { name: 'status', type: 'string', description: 'Filter by live state.', enum: ['pending', 'paused'] },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
        {
          name: 'all',
          type: 'boolean',
          description: 'List across all groups (host default when no --group; accepted for explicitness).',
        },
      ],
      handler: async (args, ctx) => listTasks(args, ctx),
      // Server-rendered run-history table (frame `human` field) — the container
      // agent gets the same legible view as the host CLI without a Bun-side
      // formatter copy.
      formatHuman: (rows) => formatTasksTable(rows as Parameters<typeof formatTasksTable>[0]),
    },
    get: {
      access: 'open',
      description: 'Get a task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => getTask(args, ctx),
    },
    create: {
      access: 'open',
      description:
        `Create a scheduled task (recurring or one-shot) in the agent group system session.\n\n` +
        `Requires --prompt plus EITHER --recurrence (recurring; first run derived from the cron grid) OR --process-after (one-shot, ISO 8601 or naive local). Always pass --name for a readable id.\n\n` +
        `--script contract (pre-task gate, runs BEFORE the agent wakes):\n` +
        `  bash, 30s timeout, 1MB output cap. Its LAST stdout line must be JSON:\n` +
        `    {"wakeAgent": <bool>, "data": {...}}\n` +
        `  wakeAgent=false marks the run handled without waking the agent (zero tokens);\n` +
        `  wakeAgent=true wakes the agent with data attached to the prompt.\n` +
        `  DO: print the JSON as the very last line, exit 0, keep data small (a summary, not a dump).\n` +
        `  DON'T: print anything after the JSON, prompt for input, or rely on state from previous runs.\n` +
        `  Always test with bash -c '<script>' before scheduling.\n` +
        `  Persist state between fires under the group workspace (e.g. a last-seen id file).\n` +
        `  Use good judgement on whether to share with the user the script (only if they are technical), a description of the script condition, or whether there's no need.\n\n` +
        `Frequency limit: recurrences more frequent than ${MAX_DAILY_FIRES} fires/day are refused unless the task\n` +
        `carries a --script gate (the script decides whether each fire needs you — a gated fire that\n` +
        `finds nothing costs zero tokens) or you pass --dangerously-override-recurrence-limit after\n` +
        `the user explicitly confirmed they want an ungated frequent task.\n\n` +
        `Failure backoff: a script that ERRORS repeatedly backs the series off (2,4,8,…60 min between fires; each errored fire counts as a failed run); after 8 consecutive failures the series is auto-paused with a note in its run log — fix the script, then \`ncl tasks resume <id>\`. A deliberate wakeAgent=false is a normal run and never backs off. \`ncl tasks get <id>\` shows failed_runs and the run log.`,
      args: [
        {
          name: 'name',
          type: 'string',
          description: 'Short descriptive name → readable task id (<slug>-<hex>). Without it, ids are t-<hex>.',
        },
        { name: 'prompt', type: 'string', description: 'Task prompt the agent wakes to.', required: true },
        {
          name: 'recurrence',
          type: 'string',
          description:
            'Cron expression (instance TZ). First run derives from the cron grid when --process-after is omitted.',
        },
        {
          name: 'dangerously_override_recurrence_limit',
          type: 'boolean',
          description:
            'Schedule more than 4 fires/day anyway. Only after the user explicitly confirmed they understand the quota/token cost and you agree it is right.',
        },
        {
          name: 'process_after',
          type: 'string',
          description: 'First/next run time (ISO 8601 or naive local). Required for one-shots.',
        },
        {
          name: 'script',
          type: 'string',
          description: 'Pre-task gate script (bash) — see the --script contract above.',
        },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
      ],
      examples: [
        `# Recurring — --recurrence alone is enough; the first run comes off the cron grid:\nncl tasks create --name "sales briefing" --prompt "Send the weekday sales briefing" --recurrence "0 9 * * 1-5"`,
        `# One-shot — --process-after required (UTC, offset, or naive-local in the instance TZ):\nncl tasks create --name "ping" --prompt "Remind me to call Dana" --process-after "tomorrow 18:00"`,
        `# Monitor — script gates the run; the agent wakes only when something matters:\nncl tasks create --name "alert watch" --recurrence "*/15 * * * *" \\\n  --prompt "Investigate the alerts in the script data and notify me if serious" \\\n  --script 'c=$(curl -sf https://example.com/api/alerts | jq length) || exit 0\necho "{\\"wakeAgent\\": $([ "$c" -gt 0 ] && echo true || echo false), \\"data\\": {\\"alerts\\": $c}}"'`,
      ],
      handler: async (args, ctx) => createTask(args, ctx),
    },
    'append-log': {
      access: 'open',
      description:
        'Append a one-line note to a task run log (tasks/<id>.md).\n\nOptional: every task run auto-logs its final text, so use this only for additive mid-run notes. The host stamps the local timestamp; you supply --msg. This is a LOG ENTRY, not a message — it sends nothing to anyone. Inside a task run --id is auto-derived from your session.',
      examples: [
        `# Inside a task run (--id auto-derived) — optional progress note:\nncl tasks append-log --msg "one feed returned 403; continuing with the remaining feeds"`,
      ],
      args: [
        {
          name: 'msg',
          type: 'string',
          description:
            'Your work-log entry: what you did and why it mattered (like a human work log). The host prepends the local timestamp; this is logged, never sent to the user.',
          required: true,
        },
        {
          name: 'id',
          type: 'string',
          description: 'Task series id. Auto-derived when called from inside a task run; required otherwise.',
        },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
      ],
      handler: async (args, ctx) => appendTaskLog(args, ctx),
    },
    update: {
      access: 'open',
      description: 'Update a live task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        { name: 'prompt', type: 'string', description: 'Replace the task prompt.' },
        { name: 'process_after', type: 'string', description: 'New next-run time (ISO 8601 or naive local).' },
        { name: 'recurrence', type: 'string', description: 'New cron expression; "null"/"none" clears it (one-shot).' },
        {
          name: 'dangerously_override_recurrence_limit',
          type: 'boolean',
          description:
            'Schedule more than 4 fires/day anyway. Only after the user explicitly confirmed they understand the quota/token cost and you agree it is right.',
        },
        { name: 'script', type: 'string', description: 'New pre-task script; "null"/"none" removes it.' },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => updateTaskCommand(args, ctx),
    },
    cancel: {
      access: 'open',
      description: 'Cancel a live task by series id, or use --all as a kill switch.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id (omit with --all).' },
        { name: 'all', type: 'boolean', description: 'Cancel every live task in scope — kill switch.' },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => cancelTaskCommand(args, ctx),
    },
    run: {
      access: 'open',
      description:
        'Fire a task now without changing its schedule (queues an extra run due immediately). Safe for testing — unlike update --process-after now, it neither consumes a one-shot nor advances a recurring series.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => runTaskCommand(args, ctx),
    },
    pause: {
      access: 'open',
      description: 'Pause a pending task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => mutateTask(args, ctx, (mailbox, id) => mailbox.pauseTask(id)),
    },
    resume: {
      access: 'open',
      description: 'Resume a paused task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => mutateTask(args, ctx, (mailbox, id) => mailbox.resumeTask(id)),
    },
    delete: {
      access: 'open',
      description: 'Hard-delete a task series and its history.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => deleteTaskCommand(args, ctx),
    },
  },
});
