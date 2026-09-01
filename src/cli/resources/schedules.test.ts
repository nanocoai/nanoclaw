/**
 * Tests for `ncl schedules` — the cross-session task aggregator + mutations
 * that drive the Slack-home Scheduled-tasks tab.
 *
 * Covers the contract's load-bearing behaviors:
 *   1. list aggregates live series across a group's sessions (one row per
 *      series, live row wins after recurrence) and never crosses groups.
 *   2. pause/resume/cancel locate the series' session and mutate its
 *      inbound.db via the scheduling primitives.
 *   3. Fail-soft list: a session folder with no inbound.db contributes
 *      nothing instead of failing the verb.
 *
 * Uses dispatch() with caller 'host' — the same path the governance
 * service's `ncl … --json` subprocess takes.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-schedules' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-schedules';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { openInboundDb } from '../../mailbox/sqlite/session-db.js';
import { insertTaskRow } from '../../mailbox/sqlite/tasks.js';
import { initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { dispatch } from '../dispatch.js';

// Side-effect import: registers the `schedules` resource.
import './schedules.js';

const GROUP = 'ag-sched';
const OTHER_GROUP = 'ag-other';
const S1 = 'sess-sched-1';
const S2 = 'sess-sched-2';
const OTHER_S = 'sess-other-1';

function now(): string {
  return new Date().toISOString();
}

function makeSession(agentGroupId: string, sessionId: string): Session {
  return {
    id: sessionId,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
}

function seedTask(
  agentGroupId: string,
  sessionId: string,
  id: string,
  opts: { recurrence?: string | null; processAfter?: string; prompt?: string } = {},
): void {
  const db = openInboundDb(inboundDbPath(agentGroupId, sessionId));
  insertTaskRow(db, {
    id,
    seriesId: id,
    processAfter: opts.processAfter ?? now(),
    recurrence: opts.recurrence ?? null,
    content: JSON.stringify({ prompt: opts.prompt ?? `do ${id}` }),
  });
}

async function run(verb: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await dispatch({ id: `req-${Math.random()}`, command: `schedules-${verb}`, args }, { caller: 'host' });
  expect(resp.ok).toBe(true);
  if (!resp.ok) throw new Error('unreachable');
  return resp.data as Record<string, unknown>;
}

function taskStatus(agentGroupId: string, sessionId: string, id: string): string | undefined {
  const db = openInboundDb(inboundDbPath(agentGroupId, sessionId));
  const row = db
    .prepare('SELECT status FROM messages_in WHERE id = ? OR series_id = ? ORDER BY seq DESC')
    .get(id, id) as { status: string } | undefined;
  return row?.status;
}

describe('schedules CLI resource', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = await initTestDb();
    await runMigrations(db);

    await createAgentGroup({ id: GROUP, name: 'sdr', folder: 'sdr', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: OTHER_GROUP, name: 'other', folder: 'other', agent_provider: null, created_at: now() });
    await createSession(makeSession(GROUP, S1));
    await createSession(makeSession(GROUP, S2));
    await createSession(makeSession(OTHER_GROUP, OTHER_S));
    initSessionFolder(GROUP, S1);
    initSessionFolder(GROUP, S2);
    initSessionFolder(OTHER_GROUP, OTHER_S);
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('list aggregates live tasks across the group sessions, soonest first, never crossing groups', async () => {
    seedTask(GROUP, S1, 'task-early', { processAfter: '2030-01-01T00:00:00Z', recurrence: '0 9 * * *' });
    seedTask(GROUP, S2, 'task-late', { processAfter: '2031-01-01T00:00:00Z' });
    seedTask(OTHER_GROUP, OTHER_S, 'task-foreign');

    const data = await run('list', { group: GROUP });
    const tasks = data.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.series_id)).toEqual(['task-early', 'task-late']);
    expect(tasks[0]).toMatchObject({
      session_id: S1,
      status: 'pending',
      recurrence: '0 9 * * *',
      prompt: 'do task-early',
      has_script: false,
    });
  });

  it('pause → sweep-visible paused status → resume → cancel, located by series across sessions', async () => {
    seedTask(GROUP, S2, 'task-x', { recurrence: '0 9 * * *' });

    await run('pause', { group: GROUP, task_id: 'task-x' });
    expect(taskStatus(GROUP, S2, 'task-x')).toBe('paused');
    let tasks = (await run('list', { group: GROUP })).tasks as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({ series_id: 'task-x', status: 'paused' });

    await run('resume', { group: GROUP, task_id: 'task-x' });
    expect(taskStatus(GROUP, S2, 'task-x')).toBe('pending');

    const res = await run('cancel', { group: GROUP, task_id: 'task-x' });
    expect(res).toMatchObject({ cancelled: 'task-x', session_id: S2 });
    expect(taskStatus(GROUP, S2, 'task-x')).toBe('cancelled');
    tasks = (await run('list', { group: GROUP })).tasks as Array<Record<string, unknown>>;
    expect(tasks).toEqual([]);
  });

  it('update merges prompt/recurrence into the live row', async () => {
    seedTask(GROUP, S1, 'task-u', { recurrence: '0 9 * * *', prompt: 'old' });

    const res = await run('update', { group: GROUP, task_id: 'task-u', prompt: 'new words', recurrence: '0 18 * * 5' });
    expect(res).toMatchObject({ updated: 'task-u', rows: 1, session_id: S1 });

    const tasks = (await run('list', { group: GROUP })).tasks as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({ prompt: 'new words', recurrence: '0 18 * * 5' });
  });

  it('mutating a task that is not in the group fails; a bare session folder is skipped on list', async () => {
    seedTask(OTHER_GROUP, OTHER_S, 'task-foreign');
    const resp = await dispatch(
      { id: 'req-miss', command: 'schedules-pause', args: { group: GROUP, task_id: 'task-foreign' } },
      { caller: 'host' },
    );
    expect(resp.ok).toBe(false);

    // A session row whose folder/db never materialized must not break list.
    await createSession(makeSession(GROUP, 'sess-ghost'));
    const data = await run('list', { group: GROUP });
    expect((data.tasks as unknown[]).length).toBe(0);
  });
});
