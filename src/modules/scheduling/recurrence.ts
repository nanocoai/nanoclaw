/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import { CronExpressionParser } from 'cron-parser';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import type { InboundMailbox } from '../../mailbox/index.js';
import { appendRunLog } from './run-log.js';

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

/** Host-written line in the series run log — no agent session exists to call
 *  append-log when a script-gated series is auto-paused. Uses the shared
 *  appendRunLog helper (one writer format); appendRunLog throws on a bad
 *  series charset or a missing agent group, and the sweep must not crash
 *  over a log line, so failures are logged and swallowed. */
async function appendHostTaskNote(agentGroupId: string, seriesId: string, note: string): Promise<void> {
  try {
    await appendRunLog(agentGroupId, seriesId, note);
  } catch (err) {
    log.warn('Could not append host task note to run log', { agentGroupId, seriesId, err });
  }
}

export async function handleRecurrence(inDb: InboundMailbox, session: Session): Promise<void> {
  const recurring = inDb.getCompletedRecurring();
  // Resolved per call, not cached at module load: a group timezone change
  // (approved `groups config update --timezone`) must shift the series from
  // the very next re-arm.
  const tz = await resolveGroupTimezone(session.agent_group_id);

  for (const msg of recurring) {
    try {
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz });
      const cronNext = interval.next().toDate();
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

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.seriesId,
        nextRun,
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
