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
import { insertTaskRow, getCompletedRecurring, SUPERSEDED_TASK_CONTENT } from './tasks.js';
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

describe('armNextTask content compaction', () => {
  const PAYLOAD = JSON.stringify({ prompt: 'x'.repeat(4096), script: 'echo hi', originSessionId: 'sess-origin' });
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  function content(db: ReturnType<typeof openInboundDb>, id: string): string {
    return (db.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string }).content;
  }

  function finish(db: ReturnType<typeof openInboundDb>, id: string, status: 'completed' | 'failed') {
    db.prepare('UPDATE messages_in SET status = ?, process_after = ? WHERE id = ?').run(
      status,
      new Date(Date.now() - 60_000).toISOString(),
      id,
    );
  }

  /** Run a series through `outcomes`, re-arming after each, like the sweep does. */
  async function runSeries(db: ReturnType<typeof openInboundDb>, outcomes: Array<'completed' | 'failed'>) {
    const mailbox = wrapSqliteInbound(db);
    insertTaskRow(db, {
      id: 'occ-0',
      seriesId: 'occ-0',
      processAfter: future(),
      recurrence: '*/10 * * * *',
      content: PAYLOAD,
    });
    for (const [i, outcome] of outcomes.entries()) {
      finish(db, `occ-${i}`, outcome);
      await mailbox.armNextTask(`occ-${i}`, {
        id: `occ-${i + 1}`,
        seriesId: 'occ-0',
        processAfter: future(),
        recurrence: '*/10 * * * *',
        content: PAYLOAD,
      });
    }
    return mailbox;
  }

  it('keeps one payload per series while every row and its stats survive', async () => {
    const db = freshDb();
    const outcomes = ['completed', 'failed', 'completed', 'failed', 'failed'] as const;
    const mailbox = await runSeries(db, [...outcomes]);

    const rows = db.prepare("SELECT id, status FROM messages_in WHERE series_id = 'occ-0' ORDER BY seq").all();
    expect(rows).toHaveLength(outcomes.length + 1);
    for (let i = 0; i < outcomes.length; i++) expect(content(db, `occ-${i}`)).toBe(SUPERSEDED_TASK_CONTENT);
    expect(content(db, `occ-${outcomes.length}`)).toBe(PAYLOAD);

    expect(mailbox.getTaskStats('occ-0')).toMatchObject({ runs: 2, failedRuns: 3 });
    expect(mailbox.getTaskStats('occ-0').lastRun).not.toBeNull();
    expect(mailbox.trailingFailedRuns('occ-0')).toBe(2);
    expect(mailbox.getTask('occ-0')?.content).toBe(PAYLOAD);
  });

  it('leaves a cancelled series its payload', async () => {
    const db = freshDb();
    const mailbox = await runSeries(db, ['completed', 'completed']);
    mailbox.cancelTask('occ-0');

    expect(mailbox.getTask('occ-0')).toMatchObject({ status: 'cancelled', content: PAYLOAD });
  });

  it('compacts a backlog left by earlier versions on the next re-arm', async () => {
    const db = freshDb();
    const mailbox = wrapSqliteInbound(db);
    for (let i = 0; i < 5; i++) {
      insertTaskRow(db, {
        id: `old-${i}`,
        seriesId: 'old-0',
        processAfter: future(),
        recurrence: null,
        content: PAYLOAD,
      });
      finish(db, `old-${i}`, 'completed');
    }
    insertTaskRow(db, {
      id: 'old-5',
      seriesId: 'old-0',
      processAfter: future(),
      recurrence: '0 9 * * *',
      content: PAYLOAD,
    });
    finish(db, 'old-5', 'completed');

    await mailbox.armNextTask('old-5', {
      id: 'old-6',
      seriesId: 'old-0',
      processAfter: future(),
      recurrence: '0 9 * * *',
      content: PAYLOAD,
    });

    for (let i = 0; i <= 5; i++) expect(content(db, `old-${i}`)).toBe(SUPERSEDED_TASK_CONTENT);
    expect(content(db, 'old-6')).toBe(PAYLOAD);
    expect(mailbox.getTaskStats('old-0').runs).toBe(6);
  });

  it('touches no other series and no non-task rows', async () => {
    const db = freshDb();
    insertTaskRow(db, { id: 'other', seriesId: 'other', processAfter: future(), recurrence: null, content: PAYLOAD });
    finish(db, 'other', 'completed');
    await runSeries(db, ['completed', 'completed']);

    expect(content(db, 'other')).toBe(PAYLOAD);
  });

  it('rolls the compaction back with the pair when the insert fails', async () => {
    const db = freshDb();
    const mailbox = await runSeries(db, ['completed']);
    finish(db, 'occ-1', 'completed');
    insertTaskRow(db, {
      id: 'occ-2',
      seriesId: 'unrelated',
      processAfter: future(),
      recurrence: null,
      content: PAYLOAD,
    });

    await expect(
      mailbox.armNextTask('occ-1', {
        id: 'occ-2',
        seriesId: 'occ-0',
        processAfter: future(),
        recurrence: '*/10 * * * *',
        content: PAYLOAD,
      }),
    ).rejects.toThrow();

    expect(content(db, 'occ-1')).toBe(PAYLOAD);
    expect(getCompletedRecurring(db).map((row) => row.id)).toEqual(['occ-1']);
  });
});
