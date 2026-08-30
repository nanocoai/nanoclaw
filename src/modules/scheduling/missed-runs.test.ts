/**
 * Tests for the missed-run policy — what happens to recurring runs nothing was
 * there to fire (host asleep, NanoClaw offline).
 *
 * Two halves: `planNextRun` (where a re-arming series lands) and
 * `applyMissedRunPolicy` (the sweep step that drops stale skip-if-missed
 * fires before the host counts due messages).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { countDueMessages, ensureSchema, openInboundDb } from '../../mailbox/sqlite/session-db.js';
import { insertTaskRow } from '../../mailbox/sqlite/tasks.js';
import { wrapSqliteInbound } from '../../mailbox/sqlite/index.js';
import { applyMissedRunPolicy, MAX_CATCH_UP_RUNS, planNextRun } from './missed-runs.js';
import type { Session } from '../../types.js';

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, TIMEZONE: 'Asia/Tokyo', GROUPS_DIR: '/tmp/nanoclaw-missed-runs-test/groups' };
});

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => (id === 'ag-test' ? { id, folder: 'g-test' } : undefined),
}));

vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ timezone: null }),
}));

const TEST_DIR = '/tmp/nanoclaw-missed-runs-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** One armed (pending) daily occurrence whose run time already passed. */
function seedDueTask(
  db: ReturnType<typeof freshDb>,
  content: Record<string, unknown>,
  lateMs: number,
  id = 'task-1',
): void {
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: new Date(Date.now() - lateMs).toISOString(),
    recurrence: '30 21 * * *',
    content: JSON.stringify({ prompt: 'daily review', ...content }),
  });
}

function processAfterOf(db: ReturnType<typeof freshDb>, id: string): string {
  return (db.prepare('SELECT process_after FROM messages_in WHERE id = ?').get(id) as { process_after: string })
    .process_after;
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('planNextRun', () => {
  const daily = { recurrence: '0 8 * * *', tz: 'Asia/Tokyo' } as const;
  const now = new Date('2026-08-30T00:00:00.000Z');

  it('anchors on now for the default policy, dropping the periods in between', () => {
    const plan = planNextRun({
      ...daily,
      policy: 'catch-up-latest',
      previousRun: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
      now,
    });
    expect(plan.next.getTime()).toBeGreaterThan(now.getTime());
    expect(plan.truncated).toBe(false);
  });

  it('anchors skip-if-missed on now too — its skipping happens in the sweep, not here', () => {
    const plan = planNextRun({
      ...daily,
      policy: 'skip-if-missed',
      previousRun: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
      now,
    });
    expect(plan.next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('catch-up-all returns the OLDEST missed period, so the series replays in order', () => {
    const previousRun = new Date(now.getTime() - 3 * DAY_MS); // ran 3 days ago
    const plan = planNextRun({ ...daily, policy: 'catch-up-all', previousRun: previousRun.toISOString(), now });
    // The first grid slot after the run that finished — still in the past, so
    // it is due immediately and the next tick replays the following one.
    expect(plan.next.getTime()).toBeGreaterThan(previousRun.getTime());
    expect(plan.next.getTime()).toBeLessThan(now.getTime());
    expect(plan.next.getTime() - previousRun.getTime()).toBeLessThanOrEqual(DAY_MS);
    expect(plan.truncated).toBe(false);
  });

  it('catch-up-all still moves forward when the series is up to date', () => {
    const plan = planNextRun({
      ...daily,
      policy: 'catch-up-all',
      previousRun: new Date(now.getTime() - 60_000).toISOString(),
      now,
    });
    expect(plan.next.getTime()).toBeGreaterThan(now.getTime());
    expect(plan.truncated).toBe(false);
  });

  it('caps a far-behind catch-up-all series at MAX_CATCH_UP_RUNS periods', () => {
    const plan = planNextRun({
      ...daily,
      policy: 'catch-up-all',
      previousRun: new Date(now.getTime() - 365 * DAY_MS).toISOString(),
      now,
    });
    expect(plan.truncated).toBe(true);
    const periodsBehind = (now.getTime() - plan.next.getTime()) / DAY_MS;
    expect(periodsBehind).toBeLessThanOrEqual(MAX_CATCH_UP_RUNS);
    expect(periodsBehind).toBeGreaterThan(MAX_CATCH_UP_RUNS - 2);
  });

  it('falls back to the grid ahead of now when the anchor is unusable', () => {
    for (const previousRun of [null, 'not-a-timestamp']) {
      const plan = planNextRun({ ...daily, policy: 'catch-up-all', previousRun, now });
      expect(plan.next.getTime()).toBeGreaterThan(now.getTime());
      expect(plan.truncated).toBe(false);
    }
  });
});

describe('applyMissedRunPolicy', () => {
  it('rolls a stale skip-if-missed run forward instead of firing it', async () => {
    const db = freshDb();
    seedDueTask(db, { recurrencePolicy: 'skip-if-missed', graceWindowSeconds: 1800 }, 5 * 60 * 60 * 1000);
    expect(countDueMessages(db)).toBe(1);

    const skipped = await applyMissedRunPolicy(wrapSqliteInbound(db), fakeSession());

    expect(skipped).toBe(1);
    // The row survives (same series, still armed) — it just no longer fires now.
    expect(countDueMessages(db)).toBe(0);
    expect(new Date(processAfterOf(db, 'task-1')).getTime()).toBeGreaterThan(Date.now());
    const row = db.prepare("SELECT status FROM messages_in WHERE id = 'task-1'").get() as { status: string };
    expect(row.status).toBe('pending');
    // …and no phantom run lands in the series' history.
    expect((db.prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c).toBe(1);
  });

  it('explains the skip in the series run log', async () => {
    const db = freshDb();
    seedDueTask(db, { recurrencePolicy: 'skip-if-missed', graceWindowSeconds: 1800 }, 5 * 60 * 60 * 1000);

    await applyMissedRunPolicy(wrapSqliteInbound(db), fakeSession());

    const logFile = path.join(TEST_DIR, 'groups', 'g-test', 'tasks', 'task-1.md');
    const content = fs.readFileSync(logFile, 'utf8');
    expect(content).toContain('skipped the');
    expect(content).toContain('1800s grace window');
  });

  it('fires a run that is late but still inside the grace window', async () => {
    const db = freshDb();
    seedDueTask(db, { recurrencePolicy: 'skip-if-missed', graceWindowSeconds: 1800 }, 10 * 60 * 1000);

    expect(await applyMissedRunPolicy(wrapSqliteInbound(db), fakeSession())).toBe(0);
    expect(countDueMessages(db)).toBe(1);
  });

  it('leaves every other policy alone — including tasks written before the policy existed', async () => {
    const db = freshDb();
    seedDueTask(db, {}, 5 * DAY_MS, 'task-legacy');
    seedDueTask(db, { recurrencePolicy: 'catch-up-all' }, 5 * DAY_MS, 'task-audit');

    expect(await applyMissedRunPolicy(wrapSqliteInbound(db), fakeSession())).toBe(0);
    expect(countDueMessages(db)).toBe(2);
  });

  it('uses the default grace window when the task does not name one', async () => {
    const db = freshDb();
    seedDueTask(db, { recurrencePolicy: 'skip-if-missed' }, 5 * 60 * 1000, 'task-inside');
    seedDueTask(db, { recurrencePolicy: 'skip-if-missed' }, 60 * 60 * 1000, 'task-outside');

    expect(await applyMissedRunPolicy(wrapSqliteInbound(db), fakeSession())).toBe(1);
    expect(new Date(processAfterOf(db, 'task-outside')).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(processAfterOf(db, 'task-inside')).getTime()).toBeLessThan(Date.now());
  });

  it('never lets one broken series stop the sweep', async () => {
    const db = freshDb();
    insertTaskRow(db, {
      id: 'task-broken',
      seriesId: 'task-broken',
      processAfter: new Date(Date.now() - DAY_MS).toISOString(),
      recurrence: 'not a cron expression',
      content: JSON.stringify({ prompt: 'x', recurrencePolicy: 'skip-if-missed' }),
    });
    seedDueTask(db, { recurrencePolicy: 'skip-if-missed' }, DAY_MS, 'task-ok');

    expect(await applyMissedRunPolicy(wrapSqliteInbound(db), fakeSession())).toBe(1);
    expect(new Date(processAfterOf(db, 'task-ok')).getTime()).toBeGreaterThan(Date.now());
  });
});
