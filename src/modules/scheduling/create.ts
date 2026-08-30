import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import type { TaskRecord } from '../../mailbox/index.js';
import { resolveTaskSession, withMailboxSession } from '../../session-manager.js';
import { parseZonedToUtc } from '../../timezone.js';
import {
  DEFAULT_GRACE_WINDOW_SECONDS,
  DEFAULT_RECURRENCE_POLICY,
  parseGraceWindowSeconds,
  parseRecurrencePolicy,
  type RecurrencePolicy,
} from './task-content.js';

export const MAX_DAILY_FIRES = 4;

const RECURRENCE_LIMIT_WARNING =
  'Warning: this task has not been scheduled. Frequent running tasks consume the ' +
  "user's subscription quota or unnecessarily use tokens and can cause the user's " +
  'account to be banned. Instead, use a pre-task run script that you write that can ' +
  'check some kind of external condition, usually via one or more API calls. The ' +
  'script returns a decision programmatically whether the task needs to be run now ' +
  'or not. For example, an API call to GitHub to check if there are open PRs, and ' +
  'only run when there are new open PRs.\n' +
  'Run `ncl tasks create --help` to get full directions on how to write a script and test it.\n\n' +
  'Note: if and only if you explicitly need to schedule a task more frequently and ' +
  "you've verified with the user that they understand and that this is what they " +
  'want and based on your judgment you agree that this is the right thing to do in ' +
  'this situation, you can override this with --dangerously-override-recurrence-limit';

export interface PreparedScheduledTask {
  name?: string;
  prompt: string;
  recurrence: string | null;
  script: string | null;
  processAfter: string;
  /** Missed-run semantics; null on a one-shot, which has no periods to miss. */
  recurrencePolicy: RecurrencePolicy | null;
  /** How late a `skip-if-missed` run may still fire; null under any other policy. */
  graceWindowSeconds: number | null;
}

export type ScheduledTaskRow = TaskRecord;

/**
 * The deterministic slug half of a task id. Exposed so template restamping can
 * find the live series a named task produced (`<slug>-<4hex>`).
 */
export function taskNameSlug(name: unknown): string {
  if (typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
}

/**
 * Short, readable, filesystem/thread-safe task id. With a name → `<slug>-<4hex>`;
 * without one → `t-<6hex>`. Always matches /^[a-z0-9-]+$/ so it is safe as a
 * thread suffix, filename, and copy-pasteable CLI argument.
 */
export function makeTaskId(name: unknown): string {
  const hex = (n: number): string => randomUUID().replace(/-/g, '').slice(0, n);
  const slug = taskNameSlug(name);
  return slug ? `${slug}-${hex(4)}` : `t-${hex(6)}`;
}

export function parseProcessAfter(value: unknown, tz: string = TIMEZONE): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('--process-after is required');
  const date = parseZonedToUtc(value, tz);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --process-after: ${value}`);
  return date.toISOString();
}

export function validateRecurrence(value: string | null | undefined, tz: string = TIMEZONE): void {
  if (!value) return;
  try {
    CronExpressionParser.parse(value, { tz });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid --recurrence: ${msg}`, { cause: err });
  }
}

export function enforceRecurrenceLimit(
  recurrence: string | null,
  override: boolean,
  hasScript: boolean,
  tz: string = TIMEZONE,
): void {
  // A gate script is the sanctioned mitigation: a skipped fire costs no agent
  // tokens, so scripted tasks may poll faster without the explicit override.
  if (!recurrence || override || hasScript) return;
  const horizon = Date.now() + 24 * 60 * 60 * 1000;
  const interval = CronExpressionParser.parse(recurrence, { tz });
  let fires = 0;
  while (fires <= MAX_DAILY_FIRES) {
    const next = interval.next();
    if (next.getTime() > horizon) break;
    fires++;
  }
  if (fires > MAX_DAILY_FIRES) throw new Error(RECURRENCE_LIMIT_WARNING);
}

/**
 * Missed-run semantics for a new task, rejected loudly when they can't apply:
 * a policy needs periods (so, a recurrence), and a grace window only means
 * anything to `skip-if-missed`.
 */
export function resolveMissedRunPolicy(input: {
  recurrence: string | null;
  recurrencePolicy?: unknown;
  graceWindowSeconds?: unknown;
}): { recurrencePolicy: RecurrencePolicy | null; graceWindowSeconds: number | null } {
  const policyGiven = input.recurrencePolicy !== undefined && input.recurrencePolicy !== null;
  const graceGiven = input.graceWindowSeconds !== undefined && input.graceWindowSeconds !== null;

  if (!input.recurrence) {
    if (policyGiven) throw new Error('--recurrence-policy applies to recurring tasks; pass --recurrence');
    if (graceGiven) throw new Error('--grace-window-seconds applies to recurring tasks; pass --recurrence');
    return { recurrencePolicy: null, graceWindowSeconds: null };
  }

  const recurrencePolicy = policyGiven ? parseRecurrencePolicy(input.recurrencePolicy) : DEFAULT_RECURRENCE_POLICY;
  if (graceGiven && recurrencePolicy !== 'skip-if-missed') {
    throw new Error('--grace-window-seconds only applies to --recurrence-policy skip-if-missed');
  }
  if (recurrencePolicy !== 'skip-if-missed') return { recurrencePolicy, graceWindowSeconds: null };
  return {
    recurrencePolicy,
    graceWindowSeconds: graceGiven ? parseGraceWindowSeconds(input.graceWindowSeconds) : DEFAULT_GRACE_WINDOW_SECONDS,
  };
}

/**
 * Validate task semantics and derive its first run without writing anything.
 * `timezone` grounds wall-clock interpretation (cron grid, naive
 * --process-after) — pass the owning group's effective timezone
 * (`resolveGroupTimezone`); it defaults to the install-global one.
 */
export function prepareScheduledTask(input: {
  name?: string;
  prompt: string;
  recurrence?: string | null;
  processAfter?: string;
  script?: string | null;
  recurrencePolicy?: unknown;
  graceWindowSeconds?: unknown;
  dangerouslyOverrideRecurrenceLimit?: boolean;
  timezone?: string;
}): PreparedScheduledTask {
  if (!input.prompt) throw new Error('--prompt is required');
  const recurrence = input.recurrence ?? null;
  const script = input.script ?? null;
  const tz = input.timezone ?? TIMEZONE;
  validateRecurrence(recurrence, tz);
  enforceRecurrenceLimit(recurrence, input.dangerouslyOverrideRecurrenceLimit === true, script !== null, tz);

  let processAfter: string;
  if (input.processAfter === undefined && recurrence) {
    const next = CronExpressionParser.parse(recurrence, { tz }).next().toISOString();
    if (!next) throw new Error(`--recurrence has no upcoming run: ${recurrence}`);
    processAfter = next;
  } else {
    processAfter = parseProcessAfter(input.processAfter, tz);
  }

  return {
    name: input.name,
    prompt: input.prompt,
    recurrence,
    script,
    processAfter,
    ...resolveMissedRunPolicy({
      recurrence,
      recurrencePolicy: input.recurrencePolicy,
      graceWindowSeconds: input.graceWindowSeconds,
    }),
  };
}

/** Persist a prepared task through NanoClaw's single task/session representation. */
export async function createScheduledTask(
  agentGroupId: string,
  task: PreparedScheduledTask,
  options?: { status?: 'pending' | 'paused'; originSessionId?: string | null },
): Promise<{ session: { id: string; agent_group_id: string }; row: ScheduledTaskRow }> {
  const id = makeTaskId(task.name);
  const { session } = await resolveTaskSession(agentGroupId, id);

  const row = await withMailboxSession(agentGroupId, session.id, async (db) => {
    await db.insertTask({
      id,
      seriesId: id,
      processAfter: task.processAfter,
      recurrence: task.recurrence,
      content: JSON.stringify({
        prompt: task.prompt,
        script: task.script,
        originSessionId: options?.originSessionId ?? null,
        // Only stored when they mean something: a one-shot has no missed
        // periods, and a grace window is a skip-if-missed concept.
        ...(task.recurrencePolicy !== null && { recurrencePolicy: task.recurrencePolicy }),
        ...(task.graceWindowSeconds !== null && { graceWindowSeconds: task.graceWindowSeconds }),
      }),
      status: options?.status ?? 'pending',
    });
    const stored = db.getTask(id);
    if (!stored) throw new Error(`task row not found after insert: ${id}`);
    return stored;
  });

  return { session: { id: session.id, agent_group_id: session.agent_group_id }, row };
}
