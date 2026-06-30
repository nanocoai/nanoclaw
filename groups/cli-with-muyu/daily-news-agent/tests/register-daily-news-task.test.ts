import { describe, expect, it } from 'vitest';
import {
  findExistingPendingTask,
  registerDailyNewsTask,
  type TaskDb,
  type TaskDbRow,
  type TaskInsert,
} from '../lib/register-daily-news-task.js';
import { DAILY_NEWS_SCRIPT } from '../lib/task-prompt.js';

function createTaskDb(): TaskDb & { rows: TaskDbRow[] } {
  const rows: TaskDbRow[] = [];
  return {
    rows,
    prepare(sql: string) {
      if (sql.includes('SELECT id, content')) {
        return {
          all(recurrence: string) {
            return rows.filter(
              (row) =>
                row.kind === 'task' &&
                row.status === 'pending' &&
                row.recurrence === recurrence,
            );
          },
          run() {},
        };
      }
      return {
        all() {
          return [];
        },
        run() {},
      };
    },
  };
}

function insertTask(
  db: TaskDb & { rows: TaskDbRow[] },
  task: TaskInsert,
): void {
  db.rows.push({
    id: task.id,
    content: task.content,
    kind: 'task',
    status: 'pending',
    recurrence: task.recurrence,
  });
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
  });
});
