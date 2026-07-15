/**
 * Tests for `handleRecurrence` — specifically the timezone-aware cron
 * interpretation ported from v1 (src/v1/task-scheduler.ts).
 *
 * Core invariant: cron expressions are interpreted in the user's TIMEZONE,
 * not UTC. Without this, `"0 9 * * *"` fires at 09:00 UTC instead of 09:00
 * user-local — a recurring scheduling bug users can't diagnose.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import { insertTaskRow } from './db.js';
import { handleRecurrence, scriptBackoffMinutes } from './recurrence.js';
import type { Session } from '../../types.js';

// Pin a non-UTC zone so the tz-interpretation test is exact even on UTC CI.
// Asia/Tokyo is UTC+9 with no DST: "0 9 * * *" must land at 00:00:00Z sharp.
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, TIMEZONE: 'Asia/Tokyo', GROUPS_DIR: '/tmp/nanoclaw-recurrence-test/groups' };
});

// The auto-pause note goes through the shared appendRunLog helper, which
// resolves the group folder from the central DB — mock it to a fixed folder.
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag-test' ? { id, folder: 'g-test' } : undefined),
}));

const TEST_DIR = '/tmp/nanoclaw-recurrence-test';
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

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('handleRecurrence', () => {
  it('clones a completed recurring task with a next-run in the future', async () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // every day at 09:00 (user TZ)
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const rows = db
      .prepare(`SELECT id, status, process_after, recurrence, series_id FROM messages_in ORDER BY seq`)
      .all() as Array<{
      id: string;
      status: string;
      process_after: string;
      recurrence: string | null;
      series_id: string;
    }>;
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.id === 'task-1')!;
    const follow = rows.find((r) => r.id !== 'task-1')!;
    expect(original.recurrence).toBeNull();
    expect(follow.status).toBe('pending');
    expect(follow.recurrence).toBe('0 9 * * *');
    expect(follow.series_id).toBe('task-1');
    expect(new Date(follow.process_after).getTime()).toBeGreaterThan(Date.now());
  });

  it('interprets the cron expression in TIMEZONE, not UTC (the v1 regression)', async () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-tz',
      seriesId: 'task-tz',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: '0 9 * * *', // 09:00 Asia/Tokyo === 00:00 UTC, exactly
      content: JSON.stringify({ prompt: 'daily digest' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-tz'`).run();

    await handleRecurrence(db, fakeSession());

    const follow = db.prepare(`SELECT process_after FROM messages_in WHERE id != 'task-tz'`).get() as {
      process_after: string;
    };
    // Drop the `{ tz: TIMEZONE }` option in recurrence.ts and this reads
    // T09:00:00 (09:00 UTC) instead — red, even on a UTC CI runner.
    expect(follow.process_after).toMatch(/T00:00:00/);
  });

  it('does not clone rows whose recurrence is already cleared', async () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-1',
      seriesId: 'task-1',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({ prompt: 'one-off' }),
    });
    db.prepare(`UPDATE messages_in SET status='completed' WHERE id='task-1'`).run();

    await handleRecurrence(db, fakeSession());

    const count = (db.prepare(`SELECT COUNT(*) AS c FROM messages_in`).get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('handleRecurrence — script-failure backoff (streak derived from failed runs)', () => {
  // A series whose last `fails` occurrences all landed as FAILED (script-skip:error
  // runs, as synced by syncProcessingAcks). Only the newest row keeps recurrence —
  // older occurrences had theirs cleared when they were re-armed. fails=0 seeds one
  // healthy completed run.
  function seedFailedStreak(db: ReturnType<typeof freshDb>, fails: number) {
    const rows = Math.max(fails, 1);
    for (let i = 0; i < rows; i++) {
      insertTaskRow(db, {
        id: `task-s-${i}`,
        seriesId: 'task-s-0',
        processAfter: '2020-01-01T00:00:00.000Z',
        recurrence: i === rows - 1 ? '* * * * *' : null, // every minute — raw cron next is ~+1min
        content: JSON.stringify({ prompt: 'monitor', script: 'exit 1' }),
      });
      db.prepare(`UPDATE messages_in SET status = ? WHERE id = ?`).run(
        fails === 0 ? 'completed' : 'failed',
        `task-s-${i}`,
      );
    }
    return `task-s-${rows - 1}`; // the row carrying recurrence
  }

  const clone = (db: ReturnType<typeof freshDb>) =>
    db.prepare(`SELECT status, process_after, recurrence FROM messages_in WHERE id NOT LIKE 'task-s-%'`).get() as {
      status: string;
      process_after: string;
      recurrence: string | null;
    };

  it('exports the documented 2,4,8,…,60 progression', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(scriptBackoffMinutes)).toEqual([2, 4, 8, 16, 32, 60, 60]);
  });

  it('pushes the clone past raw cron cadence while the script is failing', async () => {
    const db = freshDb();
    seedFailedStreak(db, 3); // streak 3 → backoff 8 min; cron next ≈ +1 min
    await handleRecurrence(db, fakeSession());

    const next = clone(db);
    expect(next.status).toBe('pending');
    const deltaMin = (new Date(next.process_after).getTime() - Date.now()) / 60_000;
    expect(deltaMin).toBeGreaterThan(7); // backoff won over the 1-min cron grid
  });

  it('a healthy series (trailing run completed) re-arms on the raw cron grid', async () => {
    const db = freshDb();
    seedFailedStreak(db, 0);
    await handleRecurrence(db, fakeSession());

    const next = clone(db);
    expect(next.status).toBe('pending');
    const deltaMin = (new Date(next.process_after).getTime() - Date.now()) / 60_000;
    expect(deltaMin).toBeLessThan(2); // no backoff applied
  });

  it('auto-pauses the series at the cap instead of re-arming', async () => {
    const db = freshDb();
    const liveId = seedFailedStreak(db, 8);
    await handleRecurrence(db, fakeSession());

    const next = clone(db);
    expect(next.status).toBe('paused'); // `ncl tasks resume` revives in place
    expect(next.recurrence).toBe('* * * * *');
    const original = db.prepare(`SELECT recurrence FROM messages_in WHERE id = ?`).get(liveId) as {
      recurrence: string | null;
    };
    expect(original.recurrence).toBeNull(); // not re-cloned next sweep
  });

  it('writes the auto-pause note into the series run log via the shared appendRunLog', async () => {
    const db = freshDb();
    seedFailedStreak(db, 8);
    await handleRecurrence(db, fakeSession());

    // Same file + format appendRunLog owns: groups/<folder>/tasks/<series>.md
    const logFile = path.join(TEST_DIR, 'groups', 'g-test', 'tasks', 'task-s-0.md');
    expect(fs.existsSync(logFile)).toBe(true);
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('auto-paused after 8 consecutive script failures');
    expect(content).toContain('ncl tasks resume task-s-0');
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — /m); // appendRunLog's local-time stamp
  });
});
