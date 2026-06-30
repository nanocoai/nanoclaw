import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  findExistingPendingTask,
  registerDailyNewsTask,
} from '../lib/register-daily-news-task.js';
import { DAILY_NEWS_SCRIPT } from '../lib/task-prompt.js';

function createTaskDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER,
      timestamp TEXT,
      status TEXT,
      tries INTEGER,
      process_after TEXT,
      recurrence TEXT,
      kind TEXT,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT,
      series_id TEXT
    );
  `);
  return db;
}

function insertTask(
  db: Database.Database,
  task: {
    id: string;
    processAfter: string;
    recurrence: string | null;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
  },
): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
     VALUES (?, 1, datetime('now'), 'pending', 0, ?, ?, 'task', ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.processAfter,
    task.recurrence,
    task.platformId,
    task.channelType,
    task.threadId,
    task.content,
    task.id,
  );
}

describe('register-daily-news-task', () => {
  it('findExistingPendingTask matches script in content', () => {
    const db = createTaskDb();
    insertTask(db, {
      id: 'task-1',
      processAfter: '2026-07-01T09:00:00',
      recurrence: '0 9 * * *',
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'p', script: DAILY_NEWS_SCRIPT }),
    });

    expect(findExistingPendingTask(db, '0 9 * * *', DAILY_NEWS_SCRIPT)).toBe('task-1');
    db.close();
  });

  it('registerDailyNewsTask is idempotent', () => {
    const db = createTaskDb();
    const first = registerDailyNewsTask(db, insertTask, {
      taskId: 'task-a',
      processAfter: '2026-07-01T09:00:00',
      prompt: 'prompt',
    });
    const second = registerDailyNewsTask(db, insertTask, {
      taskId: 'task-b',
      processAfter: '2026-07-02T09:00:00',
      prompt: 'prompt',
    });

    expect(first).toEqual({ status: 'inserted', taskId: 'task-a' });
    expect(second).toEqual({ status: 'skipped', taskId: 'task-a' });
    db.close();
  });
});
