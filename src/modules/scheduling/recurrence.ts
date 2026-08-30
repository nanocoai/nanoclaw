/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Where that next run lands is the series' missed-run policy (see
 * ./missed-runs.ts); the `skip-if-missed` half of that policy runs earlier in
 * the same sweep tick, before due messages are counted.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { InboundMailbox } from '../../mailbox/index.js';
import { MAX_CATCH_UP_RUNS, planNextRun } from './missed-runs.js';
import { appendHostTaskNote } from './run-log.js';
import { parseTaskContent } from './task-content.js';

// Consecutive pre-task-script failures (the series' trailing FAILED runs —
// derived from occurrence rows, no stored counter) throttle a broken monitor
// script instead of letting it wake a container at raw cron cadence forever.
// A deliberate wakeAgent=false gate is a normal completed run and never backs
// off. Mirrors the stuck-message retry in host-sweep.ts (BACKOFF_BASE_MS
// doubling, MAX_TRIES → failed): fail loud, don't spin.
const SCRIPT_FAIL_PAUSE_CAP = 8;
const SCRIPT_BACKOFF_CAP_MIN = 60;

/** 2, 4, 8, 16, 32, 60, 60… minutes for fails = 1, 2, 3… */
export function scriptBackoffMinutes(fails: number): number {
  return Math.min(2 * 2 ** (fails - 1), SCRIPT_BACKOFF_CAP_MIN);
}

export async function handleRecurrence(inDb: InboundMailbox, session: Session): Promise<void> {
  const recurring = inDb.getCompletedRecurring();
  // Resolved per call, not cached at module load: a group timezone change
  // (approved `groups config update --timezone`) must shift the series from
  // the very next re-arm.
  const tz = await resolveGroupTimezone(session.agent_group_id);

  for (const msg of recurring) {
    try {
      // planNextRun interprets the cron expression in the user's timezone. v1
      // did this too (src/v1/task-scheduler.ts:20-49); without it, a task
      // written "0 9 * * *" by an agent running in a user's local TZ fires at
      // 09:00 UTC instead of 09:00 user-local. The series' missed-run policy
      // decides which slot it lands on: ahead of now (the default), or the
      // next period after the run that just finished, so a `catch-up-all`
      // series walks its missed periods oldest-first instead of dropping them.
      const policy = parseTaskContent(msg.content).recurrencePolicy;
      const plan = planNextRun({
        recurrence: msg.recurrence,
        tz,
        policy,
        previousRun: msg.processAfter,
        now: new Date(),
      });
      const cronNext = plan.next;
      const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const scriptFails = inDb.trailingFailedRuns(msg.seriesId);

      if (scriptFails >= SCRIPT_FAIL_PAUSE_CAP) {
        // Re-arm PAUSED at the cron time so `ncl tasks resume` revives the
        // series in place; leave the why in the run log.
        await inDb.insertTask({
          id: newId,
          seriesId: msg.seriesId,
          processAfter: cronNext.toISOString(),
          recurrence: msg.recurrence,
          content: msg.content,
          status: 'paused',
        });
        inDb.clearRecurrence(msg.id);
        await appendHostTaskNote(
          session.agent_group_id,
          msg.seriesId,
          `auto-paused after ${scriptFails} consecutive script failures (host); fix the script, then \`ncl tasks resume ${msg.seriesId}\``,
        );
        log.warn('Task series auto-paused: script keeps failing', {
          seriesId: msg.seriesId,
          scriptFails,
          sessionId: session.id,
        });
        continue;
      }

      const backoffAt = scriptFails > 0 ? Date.now() + scriptBackoffMinutes(scriptFails) * 60_000 : 0;
      const nextRun = new Date(Math.max(cronNext.getTime(), backoffAt)).toISOString();

      await inDb.insertTask({
        id: newId,
        seriesId: msg.seriesId,
        processAfter: nextRun,
        recurrence: msg.recurrence,
        content: msg.content,
      });
      inDb.clearRecurrence(msg.id);

      if (plan.truncated) {
        await appendHostTaskNote(
          session.agent_group_id,
          msg.seriesId,
          `catch-up-all: too far behind — dropped the missed runs older than the last ${MAX_CATCH_UP_RUNS} periods`,
        );
      }

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.seriesId,
        nextRun,
        policy,
        ...(plan.truncated && { catchUpTruncated: true }),
        ...(scriptFails > 0 && { scriptFails, backoffMin: scriptBackoffMinutes(scriptFails) }),
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to compute next recurrence', {
        messageId: msg.id,
        recurrence: msg.recurrence,
        err,
      });
    }
  }
}
