/**
 * Read-only maintenance history queries for Maintenance Coordinator.
 *
 * New capability (not ported from any old commit) built per Kirk's
 * feature request: private Pepper has no direct DB access, so historical
 * maintenance questions ("what hours did Elehazar work this week?", "what
 * did Ivan say this morning?") route through Maintenance Coordinator via
 * A2A -- see src/modules/agent-to-agent/ and 93cf6ac8's dedicated
 * per-peer session isolation. These functions are what MC's own
 * historical-query tools (get_worker_time_history,
 * get_worker_activity_history) call; MC's container invokes them through
 * the CLI resource in ../../cli/resources/maintenance-history.ts.
 *
 * Everything here reads durable structured tables only -- never message
 * transcripts, never invents a missing punch, never merges two workers'
 * records. See findWorker() in identity.ts for the shared, ambiguity-safe
 * worker-resolution rule this all depends on.
 */
import { getDb } from '../../db/connection.js';
import { findWorker } from './identity.js';

// ---------------------------------------------------------------------------
// A. Worker time history
// ---------------------------------------------------------------------------

export interface WorkerTimeEventRow {
  id: string;
  worker_user_id: string;
  event_type: string;
  occurred_at: string;
  recorded_at: string;
  source_message_id: string | null;
  corrects_event_id: string | null;
  note: string;
}

export interface TimeHistoryEvent {
  id: string;
  eventType: string;
  occurredAt: string;
  recordedAt: string;
  note: string;
  /** True if a later event's corrects_event_id points at this one -- this
   *  row is preserved for audit but excluded from hours math. */
  supersededByCorrection: boolean;
  /** Set when this event itself is a correction of an earlier one. */
  correctsEventId: string | null;
}

export interface DayTimeSummary {
  /** Calendar date (UTC, YYYY-MM-DD) this day's events fall under -- storage
   *  is ISO UTC per this repo's timestamp convention; no local-timezone
   *  inference is applied here. */
  date: string;
  events: TimeHistoryEvent[];
  /** Hours from complete clock_in/clock_out pairs only. Null if the day has
   *  no complete pair at all (never a guessed/invented value). */
  hoursWorked: number | null;
  /** True if any clock_in has no matching clock_out (or vice versa) for
   *  this day -- reported faithfully, never silently completed. */
  incomplete: boolean;
  incompleteNote: string | null;
}

export interface WorkerTimeHistoryResult {
  ok: true;
  workerUserId: string;
  workerName: string;
  start: string;
  end: string;
  days: DayTimeSummary[];
  totalHours: number;
  correctionsApplied: number;
}

export interface WorkerTimeHistoryError {
  ok: false;
  reason: string;
}

function utcDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Pair clock_in/clock_out events chronologically within one day. Any other
 * event_type is informational only (kept in the day's event list, never
 * contributes to hoursWorked). A stray clock_out with no open clock_in is
 * itself an incomplete-day condition, not silently dropped.
 *
 * event_type is matched case-sensitively against exactly 'clock_in' /
 * 'clock_out' -- the schema doesn't constrain event_type values (see
 * module-maintenance-worker-state.ts), so this is a documented assumption,
 * not a schema guarantee. If the real 3pm-missing-punch policy or a richer
 * event_type vocabulary lands later, this pairing logic is the one place
 * to extend -- deliberately not baked in here per Kirk's explicit
 * instruction not to invent that policy in this tool.
 */
function summarizeDay(date: string, events: TimeHistoryEvent[]): DayTimeSummary {
  let openClockIn: TimeHistoryEvent | null = null;
  let hoursWorked = 0;
  let hadCompletePair = false;
  const problems: string[] = [];

  for (const ev of events) {
    if (ev.supersededByCorrection) continue;
    if (ev.eventType === 'clock_in') {
      if (openClockIn) {
        problems.push(`clock_in at ${openClockIn.occurredAt} was never followed by a clock_out before another clock_in at ${ev.occurredAt}`);
      }
      openClockIn = ev;
    } else if (ev.eventType === 'clock_out') {
      if (!openClockIn) {
        problems.push(`clock_out at ${ev.occurredAt} has no preceding clock_in`);
        continue;
      }
      const inMs = Date.parse(openClockIn.occurredAt);
      const outMs = Date.parse(ev.occurredAt);
      if (Number.isFinite(inMs) && Number.isFinite(outMs) && outMs > inMs) {
        hoursWorked += (outMs - inMs) / 3_600_000;
        hadCompletePair = true;
      } else {
        problems.push(`clock_out at ${ev.occurredAt} could not be paired with clock_in at ${openClockIn.occurredAt} (invalid/out-of-order timestamps)`);
      }
      openClockIn = null;
    }
  }
  if (openClockIn) {
    problems.push(`clock_in at ${openClockIn.occurredAt} has no matching clock_out for this day`);
  }

  return {
    date,
    events,
    hoursWorked: hadCompletePair ? Math.round(hoursWorked * 100) / 100 : null,
    incomplete: problems.length > 0,
    incompleteNote: problems.length > 0 ? problems.join('; ') : null,
  };
}

/**
 * Durable clock-in/out history for one worker over a date range, grouped by
 * day. Source of truth is worker_time_events (append-only) -- never
 * worker_state's "current status" memory. Corrections (corrects_event_id)
 * are applied (the correcting event counts, the corrected original is kept
 * for audit but excluded from hours math) and reported distinctly via
 * correctionsApplied. Never invents a missing punch -- an unpaired
 * clock_in/clock_out flags that day as incomplete instead.
 */
export async function getWorkerTimeHistory(
  workerRef: string,
  start: string,
  end: string,
): Promise<WorkerTimeHistoryResult | WorkerTimeHistoryError> {
  const lookup = await findWorker(workerRef);
  if (!lookup.ok || !lookup.worker) {
    return { ok: false, reason: lookup.reason ?? `worker not found: ${workerRef}` };
  }

  const rows = await getDb().all<WorkerTimeEventRow>(
    `SELECT * FROM worker_time_events
     WHERE worker_user_id = ? AND occurred_at >= ? AND occurred_at <= ?
     ORDER BY occurred_at ASC`,
    lookup.worker.user_id,
    start,
    end,
  );

  const supersededIds = new Set(rows.filter((r) => r.corrects_event_id).map((r) => r.corrects_event_id as string));
  const events: TimeHistoryEvent[] = rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
    note: r.note,
    supersededByCorrection: supersededIds.has(r.id),
    correctsEventId: r.corrects_event_id,
  }));

  const byDay = new Map<string, TimeHistoryEvent[]>();
  for (const ev of events) {
    const day = utcDate(ev.occurredAt);
    const list = byDay.get(day) ?? [];
    list.push(ev);
    byDay.set(day, list);
  }

  const days = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, dayEvents]) => summarizeDay(date, dayEvents));

  const totalHours = Math.round(days.reduce((sum, d) => sum + (d.hoursWorked ?? 0), 0) * 100) / 100;

  return {
    ok: true,
    workerUserId: lookup.worker.user_id,
    workerName: lookup.worker.name,
    start,
    end,
    days,
    totalHours,
    correctionsApplied: rows.filter((r) => r.corrects_event_id).length,
  };
}

// ---------------------------------------------------------------------------
// B. Worker activity history
// ---------------------------------------------------------------------------

export interface ActivityHistoryEntry {
  source: 'worker_activity_log' | 'worker_time_events' | 'job_completions' | 'reported_issues';
  workerUserId: string;
  occurredAt: string;
  summary: string;
  detail: Record<string, unknown>;
  /** Set only when a `property` filter was supplied -- 'exact' for
   *  reported_issues.property_reference (a real structured column),
   *  'best-effort-text' for a substring match against a free-text field
   *  (worker_activity_log.detail, job_completions.job_reference) that
   *  isn't a structured property reference in the current schema. */
  propertyMatchType?: 'exact' | 'best-effort-text';
}

export interface WorkerActivityHistoryOptions {
  worker?: string;
  start?: string;
  end?: string;
  property?: string;
}

export interface WorkerActivityHistoryResult {
  ok: true;
  workerUserId: string | null;
  entries: ActivityHistoryEntry[];
  /** Honest caveat surfaced to the caller when a property filter was used
   *  against a non-structured column -- see propertyMatchType above. */
  caveats: string[];
}

export interface WorkerActivityHistoryError {
  ok: false;
  reason: string;
}

function timeRangeClause(column: string, start?: string, end?: string): { clause: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (start) {
    parts.push(`${column} >= ?`);
    params.push(start);
  }
  if (end) {
    parts.push(`${column} <= ?`);
    params.push(end);
  }
  return { clause: parts.length ? `AND ${parts.join(' AND ')}` : '', params };
}

/**
 * Merged, chronological structured history for one worker (or all workers)
 * across every durable MC record type -- never transcript inference. See
 * ActivityHistoryEntry.propertyMatchType for the one place this isn't
 * fully structured today (no property_id column on worker_activity_log /
 * job_completions in the current schema).
 */
export async function getWorkerActivityHistory(
  opts: WorkerActivityHistoryOptions,
): Promise<WorkerActivityHistoryResult | WorkerActivityHistoryError> {
  let workerUserId: string | null = null;
  if (opts.worker) {
    const lookup = await findWorker(opts.worker);
    if (!lookup.ok || !lookup.worker) {
      return { ok: false, reason: lookup.reason ?? `worker not found: ${opts.worker}` };
    }
    workerUserId = lookup.worker.user_id;
  }

  const db = getDb();
  const entries: ActivityHistoryEntry[] = [];
  const caveats: string[] = [];
  const propertyPattern = opts.property ? `%${opts.property}%` : null;

  {
    const { clause, params } = timeRangeClause('occurred_at', opts.start, opts.end);
    const workerClause = workerUserId ? 'AND worker_user_id = ?' : '';
    const rows = await db.all<{
      id: string;
      worker_user_id: string;
      activity_type: string;
      detail: string;
      occurred_at: string;
      source_message_id: string | null;
    }>(
      `SELECT * FROM worker_activity_log WHERE 1=1 ${workerClause} ${clause} ORDER BY occurred_at ASC`,
      ...(workerUserId ? [workerUserId] : []),
      ...params,
    );
    for (const r of rows) {
      const matchesProperty = !propertyPattern || r.detail.toLowerCase().includes(opts.property!.toLowerCase());
      if (propertyPattern && !matchesProperty) continue;
      entries.push({
        source: 'worker_activity_log',
        workerUserId: r.worker_user_id,
        occurredAt: r.occurred_at,
        summary: `${r.activity_type}: ${r.detail}`.trim(),
        detail: { activityType: r.activity_type, detail: r.detail, sourceMessageId: r.source_message_id },
        ...(propertyPattern ? { propertyMatchType: 'best-effort-text' as const } : {}),
      });
    }
  }

  {
    const { clause, params } = timeRangeClause('occurred_at', opts.start, opts.end);
    const workerClause = workerUserId ? 'AND worker_user_id = ?' : '';
    const rows = await db.all<WorkerTimeEventRow>(
      `SELECT * FROM worker_time_events WHERE 1=1 ${workerClause} ${clause} ORDER BY occurred_at ASC`,
      ...(workerUserId ? [workerUserId] : []),
      ...params,
    );
    // Time events carry no property reference at all -- excluded entirely
    // (not even best-effort) when a property filter is active, rather than
    // pretending to match.
    if (!propertyPattern) {
      for (const r of rows) {
        entries.push({
          source: 'worker_time_events',
          workerUserId: r.worker_user_id,
          occurredAt: r.occurred_at,
          summary: `${r.event_type}${r.note ? ` (${r.note})` : ''}`,
          detail: { eventType: r.event_type, note: r.note, correctsEventId: r.corrects_event_id },
        });
      }
    }
  }

  {
    const { clause, params } = timeRangeClause('reported_at', opts.start, opts.end);
    const workerClause = workerUserId ? 'AND worker_user_id = ?' : '';
    const rows = await db.all<{
      id: string;
      job_reference: string;
      worker_user_id: string;
      reported_at: string;
      photo_path: string | null;
      status: string;
      source_message_id: string | null;
    }>(
      `SELECT * FROM job_completions WHERE 1=1 ${workerClause} ${clause} ORDER BY reported_at ASC`,
      ...(workerUserId ? [workerUserId] : []),
      ...params,
    );
    for (const r of rows) {
      const matchesProperty = !propertyPattern || r.job_reference.toLowerCase().includes(opts.property!.toLowerCase());
      if (propertyPattern && !matchesProperty) continue;
      entries.push({
        source: 'job_completions',
        workerUserId: r.worker_user_id,
        occurredAt: r.reported_at,
        summary: `job completion reported for ${r.job_reference} (${r.status})`,
        detail: { jobReference: r.job_reference, status: r.status, photoPath: r.photo_path },
        ...(propertyPattern ? { propertyMatchType: 'best-effort-text' as const } : {}),
      });
    }
  }

  {
    const { clause, params } = timeRangeClause('reported_at', opts.start, opts.end);
    const workerClause = workerUserId ? 'AND worker_user_id = ?' : '';
    const propertyClause = propertyPattern ? 'AND property_reference LIKE ?' : '';
    const rows = await db.all<{
      id: string;
      worker_user_id: string;
      property_reference: string;
      unit: string | null;
      description: string;
      urgency: string;
      reported_at: string;
      status: string;
      kirk_decision: string | null;
    }>(
      `SELECT * FROM reported_issues WHERE 1=1 ${workerClause} ${clause} ${propertyClause} ORDER BY reported_at ASC`,
      ...(workerUserId ? [workerUserId] : []),
      ...params,
      ...(propertyPattern ? [propertyPattern] : []),
    );
    for (const r of rows) {
      entries.push({
        source: 'reported_issues',
        workerUserId: r.worker_user_id,
        occurredAt: r.reported_at,
        summary: `reported issue at ${r.property_reference}${r.unit ? ` unit ${r.unit}` : ''}: ${r.description} (${r.status})`,
        detail: {
          propertyReference: r.property_reference,
          unit: r.unit,
          description: r.description,
          urgency: r.urgency,
          status: r.status,
          kirkDecision: r.kirk_decision,
        },
        ...(propertyPattern ? { propertyMatchType: 'exact' as const } : {}),
      });
    }
  }

  if (propertyPattern) {
    caveats.push(
      'property filter: exact match against reported_issues.property_reference; best-effort substring match against worker_activity_log.detail and job_completions.job_reference (no structured property column exists on those tables yet); worker_time_events carries no property reference at all and is excluded entirely when filtering by property.',
    );
  }

  entries.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

  return { ok: true, workerUserId, entries, caveats };
}
