import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-lean-tasks',
    GROUPS_DIR: '/tmp/nanoclaw-test-lean-tasks/groups',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-lean-tasks';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import { dispatch } from '../../cli/dispatch.js';
import type { CallerContext } from '../../cli/frame.js';
// The real barrels: the fields exist only when the modules barrel registers them.
import '../index.js';
import '../../cli/resources/index.js';

const ctx: CallerContext = { caller: 'agent', agentGroupId: 'ag-1', sessionId: 'chat-1', messagingGroupId: 'mg-1' };

function storedContent(sessionId: string): Record<string, unknown> {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  const row = db.prepare("SELECT content FROM messages_in WHERE kind = 'task'").get() as { content: string };
  db.close();
  return JSON.parse(row.content);
}

describe('lean task fields', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: now });
    await createSession({
      id: 'chat-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    });
    initSessionFolder('ag-1', 'chat-1');
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('stores --lean and --render in the task envelope, updates and clears them', async () => {
    const created = await dispatch(
      {
        id: 'c',
        command: 'tasks-create',
        args: { prompt: 'check', process_after: '2999-01-01T00:00:00Z', lean: 'true', render: 'bun render.ts' },
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { series_id, session_id } = created.data as { series_id: string; session_id: string };
    expect(storedContent(session_id)).toMatchObject({ prompt: 'check', lean: true, render: 'bun render.ts' });

    const updated = await dispatch(
      { id: 'u', command: 'tasks-update', args: { id: series_id, lean: 'false', render: 'none' } },
      ctx,
    );
    expect(updated.ok).toBe(true);
    expect(storedContent(session_id)).toMatchObject({ prompt: 'check', lean: false, render: null });

    const got = await dispatch({ id: 'g', command: 'tasks-get', args: { id: series_id } }, ctx);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.data).toMatchObject({ lean: false, render: null });
  });

  it('rejects a non-boolean --lean', async () => {
    const bad = await dispatch(
      { id: 'b', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', lean: 'yes' } },
      ctx,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain('--lean must be true or false');
  });
});
