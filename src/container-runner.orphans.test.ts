/**
 * The host sweep's orphan stop: a supervised session whose session row or
 * agent group was deleted is stopped, one whose rows exist (or whose spawn is
 * still in flight) is not, and the runtime is never listed for it.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';

const { snapshots, listSessions, prepare } = vi.hoisted(() => {
  const snapshots: SupervisedSnapshot[] = [];
  return { snapshots, listSessions: vi.fn(async () => snapshots), prepare: vi.fn() };
});
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  const root = '/tmp/nanoclaw-test-orphan-sweep';
  return { ...actual, DATA_DIR: `${root}/data`, GROUPS_DIR: `${root}/groups` };
});
vi.mock('./drivers/index.js', () => {
  const driver = { kind: 'fake', listSessions, prepare, capabilities: () => ({}) };
  return { getSessionDriver: () => driver, isSessionEventsDriver: () => false };
});

import {
  adoptRunningSessions,
  isContainerRunning,
  killContainer,
  stopOrphanedSessions,
  wakeContainer,
} from './container-runner.js';
import { dispatch } from './cli/dispatch.js';
import './cli/resources/groups.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession, getDb } from './db/index.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function fakeHandle(sessionId: string, start: () => Promise<void> = async () => {}) {
  const terminalCallbacks: Array<(failure?: unknown) => void> = [];
  const stop = vi.fn(async (_reason: string) => {
    for (const callback of terminalCallbacks) callback(undefined);
  });
  const handle = {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId },
    name: `nanoclaw-v2-${sessionId}`,
    start,
    stop,
    async status() {
      return { phase: 'running' };
    },
    onTerminal(callback: (failure?: unknown) => void) {
      terminalCallbacks.push(callback);
    },
  } as unknown as SupervisedHandle;
  return { handle, stop };
}

/** Register sess-1 as a supervised runtime through startup adoption. */
async function adopt() {
  const { handle, stop } = fakeHandle('sess-1');
  snapshots.push({ handle, phase: 'running' } as SupervisedSnapshot);
  expect((await adoptRunningSessions()).adopted).toBe(1);
  listSessions.mockClear();
  return stop;
}

function session(id: string): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  };
}

beforeEach(async () => {
  snapshots.length = 0;
  listSessions.mockClear();
  prepare.mockReset();
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createSession(session('sess-1'));
});

afterEach(async () => {
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  await closeDb();
  fs.rmSync('/tmp/nanoclaw-test-orphan-sweep', { recursive: true, force: true });
});

describe('stopOrphanedSessions', () => {
  it('leaves a session whose rows exist alone', async () => {
    const stop = await adopt();
    expect(await stopOrphanedSessions()).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    expect(isContainerRunning('sess-1')).toBe(true);
  });

  it('stops and unregisters a session whose row was deleted, without listing the runtime', async () => {
    const stop = await adopt();
    await getDb().run('DELETE FROM sessions WHERE id = ?', 'sess-1');
    expect(await stopOrphanedSessions()).toBe(1);
    expect(stop).toHaveBeenCalledWith('orphaned');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
    expect(listSessions).not.toHaveBeenCalled();
  });

  it('stops the session `ncl groups delete` leaves behind', async () => {
    const stop = await adopt();
    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: 'ag-1' } }, { caller: 'host' });
    expect(resp.ok).toBe(true);
    expect(await stopOrphanedSessions()).toBe(1);
    expect(stop).toHaveBeenCalledWith('orphaned');
  });

  it('stops a session whose agent group is gone while its session row remains', async () => {
    const stop = await adopt();
    await getDb().run('PRAGMA foreign_keys = OFF');
    await getDb().run('DELETE FROM agent_groups WHERE id = ?', 'ag-1');
    expect(await stopOrphanedSessions()).toBe(1);
    expect(stop).toHaveBeenCalledWith('orphaned');
  });

  it('asks nothing of the runtime when this process supervises nothing', async () => {
    expect(await stopOrphanedSessions()).toBe(0);
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe('a delete that lands mid-spawn', () => {
  it('leaves a spawn mid-start alone, then stops it on the next tick', async () => {
    await ensureContainerConfig('ag-1');
    let started!: () => void;
    const startGate = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { handle, stop } = fakeHandle('sess-1', () => startGate);
    prepare.mockResolvedValue(handle);

    const spawning = wakeContainer(session('sess-1'));
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(true));
    await getDb().run('DELETE FROM sessions WHERE id = ?', 'sess-1');
    expect(await stopOrphanedSessions()).toBe(0);
    expect(stop).not.toHaveBeenCalled();

    started();
    expect(await spawning).toBe(true);
    expect(await stopOrphanedSessions()).toBe(1);
    expect(stop).toHaveBeenCalledWith('orphaned');
  });
});
