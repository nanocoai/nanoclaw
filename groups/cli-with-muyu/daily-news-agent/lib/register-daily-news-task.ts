import type Database from 'better-sqlite3';

import { RECURRENCE } from './inbound-paths.js';
import { DAILY_NEWS_SCRIPT } from './task-prompt.js';

export function findExistingPendingTask(
  db: Database.Database,
  recurrence: string,
  script: string,
): string | null {
  const rows = db
    .prepare(
      "SELECT id, content FROM messages_in WHERE kind = 'task' AND status = 'pending' AND recurrence = ?",
    )
    .all(recurrence) as Array<{ id: string; content: string }>;

  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.content) as { script?: string | null };
      if (parsed.script === script) {
        return row.id;
      }
    } catch {
      // ignore malformed content
    }
  }

  return null;
}

export type RegisterTaskResult =
  | { status: 'inserted'; taskId: string }
  | { status: 'skipped'; taskId: string };

export function registerDailyNewsTask(
  db: Database.Database,
  insertTask: (db: Database.Database, task: {
    id: string;
    processAfter: string;
    recurrence: string | null;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  }) => void,
  options: { taskId: string; processAfter: string; prompt: string },
): RegisterTaskResult {
  const existingId = findExistingPendingTask(db, RECURRENCE, DAILY_NEWS_SCRIPT);
  if (existingId) {
    return { status: 'skipped', taskId: existingId };
  }

  insertTask(db, {
    id: options.taskId,
    processAfter: options.processAfter,
    recurrence: RECURRENCE,
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ prompt: options.prompt, script: DAILY_NEWS_SCRIPT }),
  });

  return { status: 'inserted', taskId: options.taskId };
}
