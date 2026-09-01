import Database from 'better-sqlite3';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-nanoco-agent-scheduling',
    GROUPS_DIR: '/tmp/nanoclaw-test-nanoco-agent-scheduling/groups',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-nanoco-agent-scheduling';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createSession, getSessionsByAgentGroup } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import '../commands/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';

function now(): string {
  return new Date().toISOString();
}

async function createGroup(id: string, scope: 'disabled' | 'group'): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  await ensureContainerConfig(id);
  await updateContainerConfigScalars(id, { cli_scope: scope });
}

async function createChatSession(group: string, id: string): Promise<void> {
  await createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, id);
}

function agentCtx(group: string, session: string): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: session, messagingGroupId: 'mg-1' };
}

describe('NanoCo group-scoped agent scheduling', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    await createGroup('ag-1', 'group');
    await createGroup('ag-2', 'group');
    await createChatSession('ag-1', 'chat-1');
    await createChatSession('ag-2', 'chat-2');
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('allows the own-group task lifecycle without broadening Host CLI access', async () => {
    const ctx = agentCtx('ag-1', 'chat-1');
    const created = await dispatch(
      {
        id: 'own-create',
        command: 'tasks-create',
        args: { name: 'daily-check', prompt: 'check the queue', recurrence: '0 16 * * *' },
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { series_id: seriesId, session_id: taskSessionId } = created.data as {
      series_id: string;
      session_id: string;
    };

    const taskDb = new Database(inboundDbPath('ag-1', taskSessionId), { readonly: true });
    expect(taskDb.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task'").get()).toEqual({
      count: 1,
    });
    taskDb.close();

    expect(
      (
        await dispatch(
          { id: 'own-update', command: 'tasks-update', args: { id: seriesId, prompt: 'check priority queue' } },
          ctx,
        )
      ).ok,
    ).toBe(true);
    expect((await dispatch({ id: 'own-pause', command: 'tasks-pause', args: { id: seriesId } }, ctx)).ok).toBe(
      true,
    );

    const listed = await dispatch({ id: 'own-list', command: 'tasks-list', args: {} }, ctx);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ series_id: seriesId, status: 'paused' })]),
      );
    }

    const arbitraryHostResource = await dispatch({ id: 'users', command: 'users-list', args: {} }, ctx);
    expect(arbitraryHostResource.ok).toBe(false);
    if (!arbitraryHostResource.ok) {
      expect(arbitraryHostResource.error.code).toBe('forbidden');
      expect(arbitraryHostResource.error.message).toContain('scoped to this agent group');
    }
  });

  it('rejects cross-group targets and unsupported task actions', async () => {
    const ctx = agentCtx('ag-1', 'chat-1');
    const crossGroup = await dispatch(
      {
        id: 'cross-group-create',
        command: 'tasks-create',
        args: { group: 'ag-2', prompt: 'must not exist', process_after: '2999-01-01T00:00:00Z' },
      },
      ctx,
    );
    expect(crossGroup.ok).toBe(false);
    if (!crossGroup.ok) {
      expect(crossGroup.error.code).toBe('forbidden');
      expect(crossGroup.error.message).toContain('scoped to this agent group');
    }

    const unsupported = await dispatch({ id: 'unsupported', command: 'tasks-purge', args: {} }, ctx);
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.error.code).toBe('unknown-command');

    const otherGroupList = await dispatch(
      { id: 'other-list', command: 'tasks-list', args: {} },
      agentCtx('ag-2', 'chat-2'),
    );
    expect(otherGroupList.ok).toBe(true);
    if (otherGroupList.ok) expect(otherGroupList.data).toEqual([]);
  });

  it('fails honestly and creates nothing while effective policy disables task access', async () => {
    await updateContainerConfigScalars('ag-1', { cli_scope: 'disabled' });

    const resp = await dispatch(
      {
        id: 'disabled-create',
        command: 'tasks-create',
        args: { name: 'not-created', prompt: 'do not schedule', recurrence: '0 16 * * *' },
      },
      agentCtx('ag-1', 'chat-1'),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('No task was scheduled or changed');
      expect(resp.error.message).toContain('do not claim the task was saved');
    }
    expect(
      (await getSessionsByAgentGroup('ag-1')).filter((session) => session.thread_id?.startsWith('system:tasks:')),
    ).toEqual([]);
  });
});
