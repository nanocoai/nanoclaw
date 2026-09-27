/**
 * The host sweep's orphan stop: a container whose session row or agent group
 * was deleted is stopped, one whose rows exist (or whose spawn is still in
 * flight here) is not, and only this install's sessions are listed.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';

const { runtime, listSessions, prepare, spawnGate } = vi.hoisted(() => {
  const runtime: { installed: boolean; snapshots: SupervisedSnapshot[] } = { installed: true, snapshots: [] };
  return {
    runtime,
    listSessions: vi.fn(async (installSlug: string) =>
      runtime.snapshots.filter(({ handle }) => handle.key.installSlug === installSlug),
    ),
    prepare: vi.fn(),
    // Holds spawnContainer at its first read so a test can observe a spawn in flight.
    spawnGate: { hold: null as Promise<void> | null },
  };
});
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  const root = '/tmp/nanoclaw-test-orphan-sweep';
  return { ...actual, DATA_DIR: `${root}/data`, GROUPS_DIR: `${root}/groups` };
});
vi.mock('./drivers/index.js', () => {
  const driver = { kind: 'fake', listSessions, prepare, capabilities: () => ({}) };
  return {
    getSessionDriver: () => driver,
    peekSessionDriver: () => (runtime.installed ? driver : null),
    isSessionEventsDriver: () => false,
  };
});

vi.mock('./db/agent-groups.js', async () => {
  const actual = await vi.importActual<typeof import('./db/agent-groups.js')>('./db/agent-groups.js');
  return {
    ...actual,
    getAgentGroup: async (id: string) => {
      if (spawnGate.hold) await spawnGate.hold;
      return actual.getAgentGroup(id);
    },
  };
});

import { INSTALL_SLUG } from './config.js';
import { stopOrphanedSessions, wakeContainer } from './container-runner.js';
import { dispatch } from './cli/dispatch.js';
import './cli/resources/groups.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession, getDb } from './db/index.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function snapshot(sessionId: string, agentGroupId = 'ag-1', installSlug = INSTALL_SLUG) {
  const stop = vi.fn(async () => {});
  const handle = {
    key: { installSlug, agentGroupId, sessionId },
    name: `nanoclaw-v2-${sessionId}`,
    stop,
    onTerminal() {},
  } as unknown as SupervisedHandle;
  runtime.snapshots.push({ handle, phase: 'running' } as SupervisedSnapshot);
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
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
}

beforeEach(async () => {
  runtime.installed = true;
  runtime.snapshots.length = 0;
  listSessions.mockClear();
  prepare.mockClear();
  spawnGate.hold = null;
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
  await closeDb();
  fs.rmSync('/tmp/nanoclaw-test-orphan-sweep', { recursive: true, force: true });
});

describe('stopOrphanedSessions', () => {
  it('leaves a session whose rows exist alone', async () => {
    const stop = snapshot('sess-1');
    expect(await stopOrphanedSessions()).toBe(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops a container whose session row was deleted', async () => {
    const stop = snapshot('sess-1');
    await getDb().run('DELETE FROM sessions WHERE id = ?', 'sess-1');
    expect(await stopOrphanedSessions()).toBe(1);
    expect(stop).toHaveBeenCalledWith('orphaned');
  });

  it('stops the containers `ncl groups delete` leaves behind', async () => {
    const stop = snapshot('sess-1');
    const resp = await dispatch({ id: 'req-del', command: 'groups-delete', args: { id: 'ag-1' } }, { caller: 'host' });
    expect(resp.ok).toBe(true);
    expect(await stopOrphanedSessions()).toBe(1);
    expect(stop).toHaveBeenCalledWith('orphaned');
  });

  it('stops a container whose agent group is gone while its session row remains', async () => {
    const stop = snapshot('sess-1');
    await getDb().run('PRAGMA foreign_keys = OFF');
    await getDb().run('DELETE FROM agent_groups WHERE id = ?', 'ag-1');
    expect(await stopOrphanedSessions()).toBe(1);
    expect(stop).toHaveBeenCalledWith('orphaned');
  });

  it('lists only this install, so another install’s containers are never touched', async () => {
    const foreign = snapshot('sess-other', 'ag-other', 'other-install');
    expect(await stopOrphanedSessions()).toBe(0);
    expect(listSessions).toHaveBeenCalledWith(INSTALL_SLUG);
    expect(foreign).not.toHaveBeenCalled();
  });

  it('leaves a spawn still in flight in this process for the next tick', async () => {
    let release!: () => void;
    spawnGate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawning = wakeContainer(session('sess-1'));
    const stop = snapshot('sess-1');
    await getDb().run('DELETE FROM sessions WHERE id = ?', 'sess-1');
    expect(await stopOrphanedSessions()).toBe(0);
    expect(stop).not.toHaveBeenCalled();
    spawnGate.hold = null;
    release();
    await spawning;
  });

  it('does nothing when no driver was ever selected', async () => {
    runtime.installed = false;
    snapshot('sess-orphan');
    expect(await stopOrphanedSessions()).toBe(0);
    expect(listSessions).not.toHaveBeenCalled();
  });
});

describe('spawnContainer', () => {
  it('starts no container when the rows are deleted while the spawn composes', async () => {
    const coordination = await import('./db/coordination.js');
    const actualClaim = coordination.tryClaimSession;
    await ensureContainerConfig('ag-1');
    const claimSpy = vi.spyOn(coordination, 'tryClaimSession').mockImplementation(async (args) => {
      await getDb().run('DELETE FROM sessions WHERE id = ?', 'sess-1');
      return actualClaim(args);
    });
    expect(await wakeContainer(session('sess-1'))).toBe(false);
    expect(claimSpy).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect((await coordination.getSessionClaim('sess-1'))?.claimed_by ?? null).toBeNull();
    claimSpy.mockRestore();
  });
});
