/**
 * Sweep hook for permanently-failed scheduled tasks.
 *
 * When a task row exhausts its retries, host-sweep marks it 'failed' and
 * writes a log line — nothing else. The user gets zero signal: the scheduled
 * run simply never produces output, and the agent doesn't know either. The
 * failure is only discoverable by querying inbound.db by hand.
 *
 * This hook closes that gap with the existing message flow: for each freshly
 * failed task row, insert a one-shot notice task (same routing) instructing
 * the agent to tell the user the run failed and offer to execute it now. The
 * notice rides the normal due-message wake — no new delivery path.
 *
 * Loop/spam guards:
 *  - Notice ids are deterministic (`task-failnotice-<failed id>`), and a
 *    NOT EXISTS clause skips rows that already have one → idempotent across
 *    sweep ticks.
 *  - Notice rows themselves are excluded from the scan → a failed notice
 *    never cascades into another notice.
 *  - Only failures from the last 24h are noticed → deploying this on an
 *    install with old failed rows doesn't flood the user.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { insertTask } from './db.js';

const NOTICE_ID_PREFIX = 'task-failnotice-';

interface FailedTaskRow {
  id: string;
  tries: number;
  process_after: string | null;
  recurrence: string | null;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export function notifyFailedTasks(inDb: Database.Database, session: Session): void {
  const failed = inDb
    .prepare(
      `SELECT id, tries, process_after, recurrence, platform_id, channel_type, thread_id, content
       FROM messages_in
       WHERE status = 'failed'
         AND kind = 'task'
         AND id NOT LIKE '${NOTICE_ID_PREFIX}%'
         AND datetime(COALESCE(process_after, timestamp)) > datetime('now', '-1 day')
         AND NOT EXISTS (
           SELECT 1 FROM messages_in n WHERE n.id = '${NOTICE_ID_PREFIX}' || messages_in.id
         )`,
    )
    .all() as FailedTaskRow[];

  for (const msg of failed) {
    try {
      insertTask(inDb, {
        id: `${NOTICE_ID_PREFIX}${msg.id}`,
        processAfter: new Date().toISOString(),
        recurrence: null,
        platformId: msg.platform_id,
        channelType: msg.channel_type,
        threadId: msg.thread_id,
        content: JSON.stringify({ prompt: buildNoticePrompt(msg) }),
      });

      log.warn('Inserted failure notice for permanently-failed task', {
        failedTaskId: msg.id,
        tries: msg.tries,
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to insert task failure notice', { messageId: msg.id, err });
    }
  }
}

function buildNoticePrompt(msg: FailedTaskRow): string {
  let originalPrompt = '';
  try {
    originalPrompt = (JSON.parse(msg.content) as { prompt?: string }).prompt ?? '';
  } catch {
    // Malformed content — the notice still tells the user the run failed.
  }

  return [
    `A scheduled task of yours failed permanently after ${msg.tries} attempts and did not run.`,
    `Task id: ${msg.id}`,
    `Scheduled for: ${msg.process_after ?? 'immediate execution'}`,
    msg.recurrence
      ? `Recurrence: ${msg.recurrence} (check list_tasks to confirm the series is still scheduled)`
      : 'Recurrence: none (one-shot task)',
    '',
    'Original task instructions:',
    '---',
    originalPrompt,
    '---',
    '',
    'Tell the user this scheduled run failed and produced no results. Ask whether they want you to run it now — if they confirm, follow the original task instructions above.',
  ].join('\n');
}
