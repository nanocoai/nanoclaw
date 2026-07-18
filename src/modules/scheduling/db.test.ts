/**
 * Tests for the scheduling module's task DB helpers — focused on the
 * series_id invariant that lets cancel/pause/resume/update reach the live
 * next occurrence of a recurring task, even after the row the agent
 * remembers has completed and been replaced by a follow-up.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import {
  insertTaskRow,
  insertRecurrence,
  cancelTask,
  pauseTask,
  resumeTask,
  updateTask,
  getCompletedRecurring,
  type RecurringMessage,
} from './db.js';

const TEST_DIR = '/tmp/nanoclaw-scheduling-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function insertBasicTask(db: ReturnType<typeof openInboundDb>, id: string, recurrence: string | null) {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date().toISOString(),
    recurrence,
    content: JSON.stringify({ prompt: 'noop' }),
  });
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('insertTaskRow', () => {
  it('stamps series_id = id on insert', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', null);
    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('task-1') as { series_id: string };
    expect(row.series_id).toBe('task-1');
    db.close();
  });
});

describe('cancelTask / pauseTask / resumeTask series matching', () => {
  // Simulates the recurrence chain that used to survive cancellation:
  // the original task completes → handleRecurrence spawns a follow-up
  // row → agent calls cancel_task(originalId) → historically only hit
  // the completed row, leaving the live one running.
  function seedRecurringChain(db: ReturnType<typeof openInboundDb>) {
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    // Mark the original as completed (as syncProcessingAcks would do).
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      content: JSON.stringify({ prompt: 'noop' }),
      recurrence: '0 9 * * *',
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());
  }

  it('cancel by original id reaches the live follow-up via series_id', () => {
    const db = freshDb();
    seedRecurringChain(db);

    cancelTask(db, 'task-orig');

    const live = db.prepare("SELECT id, status, recurrence FROM messages_in WHERE status = 'pending'").all();
    expect(live).toHaveLength(0);

    const followUp = db.prepare("SELECT status, recurrence FROM messages_in WHERE id = 'task-next'").get() as {
      status: string;
      recurrence: string | null;
    };
    // Cancel marks 'cancelled' (not 'completed') so it never counts as a run.
    expect(followUp.status).toBe('cancelled');
    // Recurrence cleared so the sweep doesn't spawn another clone.
    expect(followUp.recurrence).toBeNull();
    db.close();
  });

  it('cancelled task is not picked up by getCompletedRecurring', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-1', '0 9 * * *');
    cancelTask(db, 'task-1');

    const recurring = getCompletedRecurring(db);
    expect(recurring).toHaveLength(0);
    db.close();
  });

  it('pause by original id pauses the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    pauseTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('paused');
    db.close();
  });

  it('resume by original id resumes the live follow-up', () => {
    const db = freshDb();
    seedRecurringChain(db);

    db.prepare("UPDATE messages_in SET status = 'paused' WHERE id = 'task-next'").run();
    resumeTask(db, 'task-orig');

    const followUp = db.prepare("SELECT status FROM messages_in WHERE id = 'task-next'").get() as { status: string };
    expect(followUp.status).toBe('pending');
    db.close();
  });

  it('pause/resume touch ONLY status — recurrence and process_after survive the cycle', () => {
    const db = freshDb();
    seedRecurringChain(db);
    const before = db.prepare("SELECT recurrence, process_after FROM messages_in WHERE id = 'task-next'").get() as {
      recurrence: string | null;
      process_after: string | null;
    };

    pauseTask(db, 'task-next');
    resumeTask(db, 'task-next');

    const after = db.prepare("SELECT recurrence, process_after FROM messages_in WHERE id = 'task-next'").get() as {
      recurrence: string | null;
      process_after: string | null;
    };
    // A cancel-style copy-paste (clearing recurrence) would kill the series here.
    expect(after.recurrence).toBe(before.recurrence);
    expect(after.process_after).toBe(before.process_after);
    db.close();
  });
});

describe('updateTask', () => {
  it('merges supplied fields into content JSON without clobbering others', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'old', script: 'echo old', extra: 'keep me' }),
    });

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(1);

    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('task-1') as { content: string };
    const parsed = JSON.parse(row.content);
    expect(parsed.prompt).toBe('new');
    expect(parsed.script).toBe('echo old');
    expect(parsed.extra).toBe('keep me');
  });

  it('updates recurrence and process_after when supplied', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: '0 18 * * *', processAfter: '2026-02-01T00:00:00Z' });

    const row = db.prepare('SELECT recurrence, process_after FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string;
      process_after: string;
    };
    expect(row.recurrence).toBe('0 18 * * *');
    expect(row.process_after).toBe('2026-02-01T00:00:00Z');
  });

  it('clears recurrence when null is passed', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2026-01-01T00:00:00Z',
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'p' }),
    });

    updateTask(db, 'task-1', { recurrence: null });

    const row = db.prepare('SELECT recurrence FROM messages_in WHERE id = ?').get('task-1') as {
      recurrence: string | null;
    };
    expect(row.recurrence).toBeNull();
  });

  it('reaches the live follow-up via series_id when called with the original id', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-orig',
      seriesId: 'task-orig',
      processAfter: new Date().toISOString(),
      recurrence: '0 9 * * *',
      content: JSON.stringify({ prompt: 'old' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      content: JSON.stringify({ prompt: 'old' }),
      recurrence: '0 9 * * *',
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date(Date.now() + 86400000).toISOString());

    const touched = updateTask(db, 'task-orig', { prompt: 'new' });
    // Only the live follow-up should be touched — completed rows are excluded.
    expect(touched).toBe(1);

    const live = db.prepare("SELECT content FROM messages_in WHERE id = 'task-next'").get() as { content: string };
    expect(JSON.parse(live.content).prompt).toBe('new');

    // Original (completed) row left alone.
    const orig = db.prepare("SELECT content FROM messages_in WHERE id = 'task-orig'").get() as { content: string };
    expect(JSON.parse(orig.content).prompt).toBe('old');
  });

  it('returns 0 when no live task matches', () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: new Date().toISOString(),
      recurrence: null,
      content: JSON.stringify({ prompt: 'p' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-1'").run();

    const touched = updateTask(db, 'task-1', { prompt: 'new' });
    expect(touched).toBe(0);
  });
});

describe('insertRecurrence', () => {
  it('copies series_id forward', () => {
    const db = freshDb();
    insertBasicTask(db, 'task-orig', '0 9 * * *');
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-orig'").run();

    const msg: RecurringMessage = {
      id: 'task-orig',
      content: '{}',
      recurrence: '0 9 * * *',
      series_id: 'task-orig',
    };
    insertRecurrence(db, msg, 'task-next', new Date().toISOString());

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('task-next') as {
      series_id: string;
    };
    expect(row.series_id).toBe('task-orig');
    db.close();
  });
});
