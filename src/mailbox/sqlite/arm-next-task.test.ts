/**
 * `armNextTask` atomicity — the re-arm of a recurring series is one durable
 * step. The dangerous tear is a next occurrence inserted while the original
 * still carries its recurrence (re-cloned on the following tick → duplicate
 * runs); the fatal one is a cleared recurrence with no next occurrence (the
 * series silently dies). A failure mid-pair must leave the original's
 * recurrence fully intact so the next tick simply retries.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { ensureSchema, openInboundDb } from './session-db.js';
import { insertTaskRow, getCompletedRecurring } from './tasks.js';
import { wrapSqliteInbound } from './index.js';

const TEST_DIR = '/tmp/nanoclaw-arm-next-task-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function completedRecurringOriginal(db: ReturnType<typeof openInboundDb>, id: string) {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date(Date.now() - 60_000).toISOString(),
    recurrence: '0 9 * * *',
    content: JSON.stringify({ prompt: 'noop' }),
  });
  db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = ?").run(id);
}

describe('armNextTask', () => {
  it('inserts the next occurrence and clears the recurrence in one step', async () => {
    const db = freshDb();
    completedRecurringOriginal(db, 'task-original');
    const mailbox = wrapSqliteInbound(db);

    await mailbox.armNextTask('task-original', {
      id: 'task-next',
      seriesId: 'task-original',
      processAfter: new Date(Date.now() + 3_600_000).toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'noop' }),
    });

    expect(mailbox.getTask('task-next')?.id).toBe('task-next');
    expect(getCompletedRecurring(db)).toHaveLength(0);
  });

  it('a failure mid-pair leaves the recurrence intact for a clean retry', async () => {
    const db = freshDb();
    completedRecurringOriginal(db, 'task-original');
    const mailbox = wrapSqliteInbound(db);
    // Occupy the next occurrence's id so the insert inside the pair throws.
    insertTaskRow(db, {
      id: 'task-next',
      seriesId: 'unrelated',
      processAfter: new Date().toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'squatter' }),
    });

    await expect(
      mailbox.armNextTask('task-original', {
        id: 'task-next',
        seriesId: 'task-original',
        processAfter: new Date(Date.now() + 3_600_000).toISOString(),
        recurrence: '0 9 * * *',
        content: JSON.stringify({ prompt: 'noop' }),
      }),
    ).rejects.toThrow();

    // The original is still armed — the series is retryable, not dead.
    expect(getCompletedRecurring(db).map((row) => row.id)).toEqual(['task-original']);

    // And the retry with a fresh id completes the pair.
    await mailbox.armNextTask('task-original', {
      id: 'task-next-retry',
      seriesId: 'task-original',
      processAfter: new Date(Date.now() + 3_600_000).toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'noop' }),
    });
    expect(getCompletedRecurring(db)).toHaveLength(0);
    expect(mailbox.getTask('task-next-retry')?.id).toBe('task-next-retry');
  });
});
