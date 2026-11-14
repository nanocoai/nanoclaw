/**
 * `nextDueAt` — the instant the next pending wake-triggering row becomes due.
 * The due-time wake feed (src/due-wake.ts) arms its timer from it.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { ensureSchema, nextDueAt, openInboundDb } from './session-db.js';
import { insertTaskRow } from './tasks.js';
import { wrapSqliteInbound } from './index.js';

const TEST_DIR = '/tmp/nanoclaw-next-due-at-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function task(db: ReturnType<typeof openInboundDb>, id: string, offsetMs: number, status = 'pending') {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date(Date.now() + offsetMs).toISOString(),
    recurrence: null,
    content: JSON.stringify({ prompt: 'noop' }),
  });
  if (status !== 'pending') db.prepare('UPDATE messages_in SET status = ? WHERE id = ?').run(status, id);
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('nextDueAt', () => {
  it('returns null when nothing is scheduled in the future', () => {
    const db = freshDb();
    task(db, 'task-past', -60_000);
    expect(nextDueAt(db)).toBeNull();
  });

  it('returns the earliest future pending row', () => {
    const db = freshDb();
    task(db, 'task-later', 120_000);
    task(db, 'task-sooner', 30_000);
    const at = nextDueAt(db);
    expect(at).not.toBeNull();
    const delta = Date.parse(at!) - Date.now();
    expect(delta).toBeGreaterThan(20_000);
    expect(delta).toBeLessThanOrEqual(30_000);
  });

  it('ignores paused and non-triggering rows', () => {
    const db = freshDb();
    task(db, 'task-paused', 10_000, 'paused');
    task(db, 'task-silent', 20_000);
    db.prepare('UPDATE messages_in SET trigger = 0 WHERE id = ?').run('task-silent');
    expect(nextDueAt(db)).toBeNull();
  });

  it('the mailbox normalizes a naive SQLite timestamp to ISO UTC', () => {
    const db = freshDb();
    task(db, 'task-naive', 0);
    const due = new Date(Date.now() + 90_000);
    const naive = due.toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('UPDATE messages_in SET process_after = ? WHERE id = ?').run(naive, 'task-naive');
    expect(wrapSqliteInbound(db).nextDueAt()).toBe(`${naive.replace(' ', 'T')}.000Z`);
  });
});
