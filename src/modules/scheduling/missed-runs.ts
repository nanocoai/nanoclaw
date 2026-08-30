/**
 * Missed-run policy for recurring tasks (see RECURRENCE_POLICIES).
 *
 * Two halves, both driven by the per-series policy in the task content
 * envelope:
 *
 *   - `planNextRun` — where the NEXT occurrence lands when a series re-arms.
 *     `catch-up-all` anchors on the period that just ran, so a series that is
 *     behind walks its missed periods oldest-first (one per sweep tick, since
 *     each occurrence only re-arms once the previous one completes). Every
 *     other policy anchors on now, which is the historical behavior.
 *
 *   - `applyMissedRunPolicy` — the sweep step that drops stale `skip-if-missed`
 *     fires. It must run BEFORE the sweep's due-message count, or the container
 *     wakes for the very run we mean to skip.
 */
import { CronExpressionParser } from 'cron-parser';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import { formatLocalTime } from '../../timezone.js';
import type { InboundMailbox } from '../../mailbox/index.js';
import type { Session } from '../../types.js';
import { appendHostTaskNote } from './run-log.js';
import { parseTaskContent, type RecurrencePolicy } from './task-content.js';

/**
 * How many missed periods a `catch-up-all` series may replay. A daily task
 * that was offline for three months must not wake the agent 90 times (each
 * replay is a real agent turn against the user's quota), so the series jumps
 * forward to the last MAX_CATCH_UP_RUNS periods and says so in its run log.
 */
export const MAX_CATCH_UP_RUNS = 24;

export interface NextRunPlan {
  /** When the next occurrence should fire. */
  next: Date;
  /** True when older missed periods were dropped to honour MAX_CATCH_UP_RUNS. */
  truncated: boolean;
}

/**
 * Next occurrence for a re-arming series. `previousRun` is the scheduled time
 * of the occurrence that just finished — the anchor `catch-up-all` counts from.
 */
export function planNextRun(args: {
  recurrence: string;
  tz: string;
  policy: RecurrencePolicy;
  previousRun: string | null;
  now: Date;
}): NextRunPlan {
  const { recurrence, tz, policy, previousRun, now } = args;
  const fromNow = (): Date => CronExpressionParser.parse(recurrence, { tz, currentDate: now }).next().toDate();

  if (policy !== 'catch-up-all') return { next: fromNow(), truncated: false };

  const anchor = previousRun === null ? NaN : Date.parse(previousRun);
  if (!Number.isFinite(anchor)) return { next: fromNow(), truncated: false };

  const candidate = CronExpressionParser.parse(recurrence, { tz, currentDate: new Date(anchor) })
    .next()
    .toDate();
  if (candidate.getTime() > now.getTime()) return { next: candidate, truncated: false };

  // Behind. The floor is the MAX_CATCH_UP_RUNS-th most recent occurrence at or
  // before now — walking backwards costs a bounded number of steps no matter
  // how far behind the series is (walking forwards from the anchor does not).
  let floor = candidate;
  try {
    const backwards = CronExpressionParser.parse(recurrence, { tz, currentDate: now });
    let cursor = candidate;
    for (let i = 0; i < MAX_CATCH_UP_RUNS; i++) cursor = backwards.prev().toDate();
    floor = cursor;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a cron with fewer past occurrences than the cap has nothing to truncate
  } catch {
    floor = candidate;
  }

  if (candidate.getTime() >= floor.getTime()) return { next: candidate, truncated: false };
  return { next: floor, truncated: true };
}

/** How late a due occurrence is, in ms; null when its run time is unusable. */
function latenessMs(processAfter: string, now: number): number | null {
  const due = Date.parse(processAfter);
  if (!Number.isFinite(due)) return null;
  return now - due;
}

/** "4h12m" — coarse lateness for the run-log line. */
function describeLateness(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`;
}

/**
 * Roll `skip-if-missed` series past a fire they are too late for.
 *
 * The stale occurrence is rescheduled in place onto the next cron slot rather
 * than fired-and-re-armed: the skipped run never wakes a container, never
 * consumes tokens, and never lands in the series' run history as a run that
 * happened. The run log records the skip so it is still explainable.
 *
 * Returns how many occurrences were rolled forward. Never throws — a bad cron
 * on one series must not stop the sweep for the rest.
 */
export async function applyMissedRunPolicy(inDb: InboundMailbox, session: Session): Promise<number> {
  const now = Date.now();
  let candidates: ReturnType<InboundMailbox['listLiveTasks']>;
  try {
    candidates = inDb.listLiveTasks('pending');
  } catch (err) {
    log.error('Could not read live tasks for missed-run policy', { sessionId: session.id, err });
    return 0;
  }

  let tz: string | null = null;
  let skipped = 0;
  for (const row of candidates) {
    const missedAt = row.processAfter;
    if (row.recurrence === null || missedAt === null) continue;
    const content = parseTaskContent(row.content);
    if (content.recurrencePolicy !== 'skip-if-missed') continue;
    const late = latenessMs(missedAt, now);
    if (late === null || late <= content.graceWindowSeconds * 1000) continue;

    try {
      // Resolved lazily so the common tick (no stale skip-if-missed row) costs
      // no central-DB read, and per call so a group timezone change applies
      // from the very next skip.
      tz ??= await resolveGroupTimezone(session.agent_group_id);
      const next = CronExpressionParser.parse(row.recurrence, { tz, currentDate: new Date(now) })
        .next()
        .toDate();
      if (inDb.rescheduleTask(row.id, next.toISOString()) === 0) continue;
      skipped++;

      const seriesId = row.seriesId ?? row.id;
      log.info('Skipped a missed task run (skip-if-missed)', {
        sessionId: session.id,
        seriesId,
        rowId: row.id,
        missedRun: missedAt,
        lateMs: late,
        graceWindowSeconds: content.graceWindowSeconds,
        nextRun: next.toISOString(),
      });
      await appendHostTaskNote(
        session.agent_group_id,
        seriesId,
        `skipped the ${formatLocalTime(missedAt, tz)} run — ${describeLateness(late)} late, past the ` +
          `${content.graceWindowSeconds}s grace window (skip-if-missed); next run ${formatLocalTime(next.toISOString(), tz)}`,
      );
    } catch (err) {
      log.error('Failed to apply skip-if-missed policy', { sessionId: session.id, rowId: row.id, err });
    }
  }
  return skipped;
}
