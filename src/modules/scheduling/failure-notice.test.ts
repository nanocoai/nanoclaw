/**
 * Tests for `notifyFailedTasks` — the sweep hook that surfaces permanently-
 * failed scheduled tasks to the user instead of letting them die silently.
 *
 * Core invariants:
 *  - a freshly failed task gets exactly one pending notice task, with the
 *    same routing, instructing the agent to inform the user and offer a rerun
 *  - the hook is idempotent across sweep ticks
 *  - a failed notice never cascades into another notice
 *  - stale failures (older than the 24h window) are not noticed
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTask } from './db.js';
import { notifyFailedTasks } from './failure-notice.js';
import type { Session } from '../../types.js';

const TEST_DIR = '/tmp/nanoclaw-failure-notice-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: null,
    status: 'active',
    created_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
    container_status: 'stopped',
  } as Session;
}

function insertFailedTask(
  db: ReturnType<typeof openInboundDb>,
  id: string,
  opts: { processAfter?: string; recurrence?: string | null; threadId?: string | null } = {},
) {
  insertTask(db, {
    id,
    processAfter: opts.processAfter ?? new Date().toISOString(),
    recurrence: opts.recurrence ?? null,
    platformId: 'user-123',
    channelType: 'telegram',
    threadId: opts.threadId ?? 'telegram:123',
    content: JSON.stringify({ prompt: 'run the daily digest' }),
  });
  db.prepare("UPDATE messages_in SET status = 'failed', tries = 5 WHERE id = ?").run(id);
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('notifyFailedTasks', () => {
  it('inserts a pending notice task with the same routing when a task permanently fails', () => {
    const db = freshDb();
    insertFailedTask(db, 'task-1');

    notifyFailedTasks(db, fakeSession());

    const notice = db.prepare("SELECT * FROM messages_in WHERE id = 'task-failnotice-task-1'").get() as Record<
      string,
      unknown
    >;
    expect(notice).toBeDefined();
    expect(notice.status).toBe('pending');
    expect(notice.kind).toBe('task');
    expect(notice.recurrence).toBeNull();
    expect(notice.platform_id).toBe('user-123');
    expect(notice.channel_type).toBe('telegram');
    expect(notice.thread_id).toBe('telegram:123');

    const prompt = (JSON.parse(notice.content as string) as { prompt: string }).prompt;
    expect(prompt).toContain('task-1');
    expect(prompt).toContain('failed permanently after 5 attempts');
    expect(prompt).toContain('run the daily digest');
    db.close();
  });

  it('is idempotent — repeated sweeps produce a single notice', () => {
    const db = freshDb();
    insertFailedTask(db, 'task-1');

    notifyFailedTasks(db, fakeSession());
    notifyFailedTasks(db, fakeSession());
    notifyFailedTasks(db, fakeSession());

    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'task-failnotice-%'").get() as { c: number }
    ).c;
    expect(count).toBe(1);
    db.close();
  });

  it('does not cascade — a failed notice task never generates another notice', () => {
    const db = freshDb();
    insertFailedTask(db, 'task-1');
    notifyFailedTasks(db, fakeSession());

    // The notice itself exhausts its retries too.
    db.prepare("UPDATE messages_in SET status = 'failed', tries = 5 WHERE id = 'task-failnotice-task-1'").run();
    notifyFailedTasks(db, fakeSession());

    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'task-failnotice-%'").get() as { c: number }
    ).c;
    expect(count).toBe(1);
    db.close();
  });

  it('ignores failures older than the 24h notice window', () => {
    const db = freshDb();
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    insertFailedTask(db, 'task-old', { processAfter: threeDaysAgo });

    notifyFailedTasks(db, fakeSession());

    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'task-failnotice-%'").get() as { c: number }
    ).c;
    expect(count).toBe(0);
    db.close();
  });

  it('ignores tasks that completed or are still pending', () => {
    const db = freshDb();
    insertTask(db, {
      id: 'task-done',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'noop' }),
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'task-done'").run();
    insertTask(db, {
      id: 'task-waiting',
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt: 'noop' }),
    });

    notifyFailedTasks(db, fakeSession());

    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'task-failnotice-%'").get() as { c: number }
    ).c;
    expect(count).toBe(0);
    db.close();
  });
});
