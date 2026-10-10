/**
 * SQLite task helpers used by the SQLite mailbox driver.
 *
 * Tasks are `messages_in` rows with `kind='task'`. This module doesn't own
 * its own table — it piggybacks on the core schema. That's why there's no
 * `module-scheduling-*.ts` migration file.
 *
 * cancel/pause/resume match any live row in the series, not just the exact id.
 * Recurring tasks get a new row per occurrence (see handleRecurrence), all
 * sharing series_id. Matching by id alone would only hit the completed row
 * the agent remembers, missing the live next occurrence.
 */
import type Database from 'better-sqlite3';

import { nextEvenSeq } from './session-db.js';
import { createTaskInboundRecord } from '../model.js';
import type { TaskWrite } from '../model.js';

/**
 * Insert one pending task occurrence. `seriesId` is the series join key — equal
 * to `id` for a brand-new series, or the existing series for a recurrence clone
 * or an on-demand run. Tasks never set platform/channel/thread (they fire into
 * an isolated system session), so those columns are always NULL.
 */
export function insertTaskRow(db: Database.Database, row: TaskWrite, sequence = nextEvenSeq(db)): void {
  const record = createTaskInboundRecord(row, sequence, new Date().toISOString());
  db.prepare(
    `INSERT INTO messages_in
       (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
        platform_id, channel_type, thread_id, content, source_session_id, on_wake)
     VALUES
       (@id, @sequence, @kind, @timestamp, @status, @processAfter, @recurrence, @seriesId, @tries, @trigger,
        @platformId, @channelType, @threadId, @content, @sourceSessionId, @onWake)`,
  ).run({
    ...record,
    trigger: record.trigger ? 1 : 0,
    onWake: record.onWake ? 1 : 0,
  });
}

// Cancel marks the live row 'cancelled' (not 'completed') so a never-fired
// occurrence is distinguishable from a real run and never inflates run history;
// recurrence is cleared so the series isn't re-armed by handleRecurrence.
export function cancelTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run(taskId, taskId).changes;
}

export function cancelAllTasks(db: Database.Database): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE kind = 'task' AND status IN ('pending', 'paused')",
    )
    .run().changes;
}

export function pauseTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'paused' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'pending'",
    )
    .run(taskId, taskId).changes;
}

export function resumeTask(db: Database.Database, taskId: string): number {
  return db
    .prepare(
      "UPDATE messages_in SET status = 'pending' WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status = 'paused'",
    )
    .run(taskId, taskId).changes;
}

export function deleteTask(db: Database.Database, taskId: string): number {
  return db.prepare("DELETE FROM messages_in WHERE (id = ? OR series_id = ?) AND kind = 'task'").run(taskId, taskId)
    .changes;
}

export interface TaskUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

// Merges content JSON in-place so callers can update prompt/script without
// clobbering other fields. Matches by id OR series_id so the live next
// occurrence of a recurring task is updated, not just the completed row the
// agent last saw. Due occurrences are already execution candidates and remain
// immutable; only future pending or paused occurrences are updated. Returns
// the number of rows touched.
export function updateTask(db: Database.Database, taskId: string, update: TaskUpdate): number {
  const rows = db
    .prepare(
      `SELECT id, content FROM messages_in
       WHERE (id = ? OR series_id = ?)
         AND kind = 'task'
         AND (status = 'paused' OR (status = 'pending' AND datetime(process_after) > datetime('now')))`,
    )
    .all(taskId, taskId) as Array<{ id: string; content: string }>;

  if (rows.length === 0) return 0;

  const setProcessAfter = update.processAfter !== undefined;
  const setRecurrence = update.recurrence !== undefined;
  const mergeContent = update.prompt !== undefined || update.script !== undefined;

  const tx = db.transaction(() => {
    for (const row of rows) {
      let content = row.content;
      if (mergeContent) {
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        if (update.prompt !== undefined) parsed.prompt = update.prompt;
        if (update.script !== undefined) parsed.script = update.script;
        content = JSON.stringify(parsed);
      }

      // Build SET clause dynamically so callers can update fields independently.
      const sets: string[] = ['content = ?'];
      const params: unknown[] = [content];
      if (setProcessAfter) {
        sets.push('process_after = ?');
        params.push(update.processAfter);
      }
      if (setRecurrence) {
        sets.push('recurrence = ?');
        params.push(update.recurrence);
      }
      params.push(row.id);

      db.prepare(`UPDATE messages_in SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
  });
  tx();
  return rows.length;
}

// Only tasks carry a recurrence (non-task writeSessionMessage never sets one),
// so getCompletedRecurring only ever returns task rows — the fields below are
// all that handleRecurrence needs to clone the next occurrence.
export interface RecurringMessage {
  id: string;
  content: string;
  recurrence: string;
  series_id: string;
}

// Failed occurrences (script-skip:error runs) re-arm too — a broken monitor
// must keep its series alive so backoff can throttle it and the cap can pause
// it; dropping the row would silently kill the series on first script error.
export function getCompletedRecurring(db: Database.Database): RecurringMessage[] {
  return db
    .prepare("SELECT * FROM messages_in WHERE status IN ('completed', 'failed') AND recurrence IS NOT NULL")
    .all() as RecurringMessage[];
}

/**
 * Trailing consecutive FAILED occurrences of a series, newest backwards until
 * the first completed run. This IS the script-failure streak — derived from
 * the occurrence history, no stored counter to update or reset. Deliberately
 * counts ANY failed occurrence (script-skip:error acks AND stuck-message
 * failures from host-sweep's MAX_TRIES path): a series failing for either
 * reason should throttle, not spin.
 */
export function trailingFailedRuns(db: Database.Database, seriesKey: string): number {
  const rows = db
    .prepare(
      `SELECT status FROM messages_in
        WHERE (series_id = ? OR id = ?) AND kind = 'task' AND status IN ('completed', 'failed')
        ORDER BY seq DESC`,
    )
    .all(seriesKey, seriesKey) as Array<{ status: string }>;
  let streak = 0;
  for (const r of rows) {
    if (r.status !== 'failed') break;
    streak++;
  }
  return streak;
}

export function insertRecurrence(
  db: Database.Database,
  msg: RecurringMessage,
  newId: string,
  nextRun: string | null,
  status: 'pending' | 'paused' = 'pending',
): void {
  insertTaskRow(db, {
    id: newId,
    seriesId: msg.series_id,
    processAfter: nextRun,
    recurrence: msg.recurrence,
    content: msg.content,
    status,
  });
}

export function clearRecurrence(db: Database.Database, messageId: string): void {
  db.prepare('UPDATE messages_in SET recurrence = NULL WHERE id = ?').run(messageId);
}
