/**
 * The storage-neutral task content envelope.
 *
 * Tasks are `messages_in` rows; everything scheduling-specific that isn't a
 * core column lives in this JSON blob. Recurrence clones copy `content`
 * verbatim (see insertRecurrence), so anything stored here is carried forward
 * for the life of the series without a session-DB migration.
 */

/**
 * What happens to runs a series missed while nothing was there to fire them
 * (host asleep, NanoClaw offline, machine shut for the weekend).
 *
 * - `catch-up-latest` — fire the most recent missed period, skip the older
 *   ones. The historical behavior and still the default: a daily briefing
 *   should not arrive three times at once after a weekend away.
 * - `catch-up-all` — fire once per missed period, oldest first (one per sweep
 *   tick, capped at MAX_CATCH_UP_RUNS periods behind). For work that must
 *   happen for every interval even when late: audit jobs, billing rolls,
 *   per-day rollups.
 * - `skip-if-missed` — a run more than `graceWindowSeconds` late is dropped
 *   and the series rolls to its next period. For time-sensitive personal jobs
 *   whose output is misleading once stale ("daily review at 21:30").
 */
export const RECURRENCE_POLICIES = ['catch-up-latest', 'catch-up-all', 'skip-if-missed'] as const;

export type RecurrencePolicy = (typeof RECURRENCE_POLICIES)[number];

/** Historical behavior — an unset policy on an existing task means this. */
export const DEFAULT_RECURRENCE_POLICY: RecurrencePolicy = 'catch-up-latest';

/** How late a `skip-if-missed` run may be and still fire. */
export const DEFAULT_GRACE_WINDOW_SECONDS = 600;

export interface TaskContent {
  prompt: string;
  script: string | null;
  originSessionId: string | null;
  recurrencePolicy: RecurrencePolicy;
  graceWindowSeconds: number;
}

export function isRecurrencePolicy(value: unknown): value is RecurrencePolicy {
  return typeof value === 'string' && (RECURRENCE_POLICIES as readonly string[]).includes(value);
}

/** Validating parse for the CLI/agent edge — rejects unknown policies loudly. */
export function parseRecurrencePolicy(value: unknown): RecurrencePolicy {
  if (isRecurrencePolicy(value)) return value;
  throw new Error(`--recurrence-policy must be one of: ${RECURRENCE_POLICIES.join(', ')}`);
}

/** Validating parse for the CLI/agent edge — a grace window is whole seconds > 0. */
export function parseGraceWindowSeconds(value: unknown): number {
  const seconds = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds <= 0) {
    throw new Error('--grace-window-seconds must be a positive whole number of seconds');
  }
  return seconds;
}

/** Decode the storage-neutral task content envelope. */
export function parseTaskContent(raw: string): TaskContent {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
      // Tolerant on read (unlike parseRecurrencePolicy): a task written by an
      // older host, or hand-edited to something unknown, keeps running under
      // the historical semantics instead of breaking its series.
      recurrencePolicy: isRecurrencePolicy(parsed.recurrencePolicy)
        ? parsed.recurrencePolicy
        : DEFAULT_RECURRENCE_POLICY,
      graceWindowSeconds:
        typeof parsed.graceWindowSeconds === 'number' &&
        Number.isFinite(parsed.graceWindowSeconds) &&
        parsed.graceWindowSeconds > 0
          ? parsed.graceWindowSeconds
          : DEFAULT_GRACE_WINDOW_SECONDS,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- LEGACY-COMPAT(v1-tasks): plain-string content predating the JSON envelope
  } catch {
    return {
      prompt: raw,
      script: null,
      originSessionId: null,
      recurrencePolicy: DEFAULT_RECURRENCE_POLICY,
      graceWindowSeconds: DEFAULT_GRACE_WINDOW_SECONDS,
    };
  }
}
