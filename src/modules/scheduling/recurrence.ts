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
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { clearRecurrence, getCompletedRecurring, insertRecurrence } from './db.js';

/** Parse a SQLite UTC timestamp (no tz marker) as UTC, not host-local. */
function sqliteToDate(s: string | null): Date | undefined {
  if (!s) return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

export async function handleRecurrence(inDb: Database.Database, session: Session): Promise<void> {
  const recurring = getCompletedRecurring(inDb);

  for (const msg of recurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      //
      // Anchor the next occurrence on the slot that just fired (process_after)
      // rather than wall-clock now, so processing latency doesn't drift the
      // whole series forward / skip slots. If anchoring lands in the past (the
      // series fell behind, or this occurrence ran long / failed), recompute
      // from now so we jump to the next future slot instead of replaying every
      // missed one.
      const anchor = sqliteToDate(msg.process_after);
      const interval = CronExpressionParser.parse(
        msg.recurrence,
        anchor ? { tz: TIMEZONE, currentDate: anchor } : { tz: TIMEZONE },
      );
      let next = interval.next();
      if (next.toDate().getTime() <= Date.now()) {
        next = CronExpressionParser.parse(msg.recurrence, { tz: TIMEZONE }).next();
      }
      const nextRun = next.toISOString();
      const prefix = msg.kind === 'task' ? 'task' : 'msg';
      const newId = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      insertRecurrence(inDb, msg, newId, nextRun);
      clearRecurrence(inDb, msg.id);

      // A 'failed' occurrence still keeps the series alive (see
      // getCompletedRecurring) — surface it so a wedged recurring task is
      // observable rather than silently limping along.
      if (msg.status === 'failed') {
        log.warn('Recurring occurrence failed but series continues — next run scheduled', {
          originalId: msg.id,
          seriesId: msg.series_id,
          nextRun,
          sessionId: session.id,
        });
      }

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
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
