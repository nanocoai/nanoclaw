import { RECURRENCE } from './inbound-paths.js';
import { DAILY_NEWS_SCRIPT } from './task-prompt.js';

export interface TaskDbRow {
  id: string;
  content: string;
  kind: string;
  status: string;
  recurrence: string | null;
}

export interface TaskDb {
  prepare(sql: string): {
    all(recurrence: string): TaskDbRow[];
    run(...params: unknown[]): void;
  };
}

export function findExistingPendingTask(
  db: TaskDb,
  recurrence: string,
  script: string,
): string | null {
  const rows = db
    .prepare(
      "SELECT id, content FROM messages_in WHERE kind = 'task' AND status = 'pending' AND recurrence = ?",
    )
    .all(recurrence);

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

export type TaskInsert = {
  id: string;
  processAfter: string;
  recurrence: string | null;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  content: string;
};

export function registerDailyNewsTask(
  db: TaskDb,
  insertTask: (db: TaskDb, task: TaskInsert) => void,
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
