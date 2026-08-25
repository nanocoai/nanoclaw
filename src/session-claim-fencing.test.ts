/**
 * The session_claims rows are the fencing authority: a lost CAS blocks
 * adoption/spawn of a duplicate, a stale finish cannot stomp a newer
 * incarnation's bookkeeping, and a respawn intent survives the process that
 * wrote it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';

const snapshots: SupervisedSnapshot[] = [];
vi.mock('./drivers/index.js', () => ({
  getSessionDriver: () => ({
    listSessions: async () => snapshots,
    capabilities: () => ({}),
  }),
  isSessionEventsDriver: () => false,
}));

import { adoptRunningSessions, honorPendingStopIntents, isContainerRunning, killContainer } from './container-runner.js';
import { getSessionClaim, setStopIntent, tryClaimSession } from './db/coordination.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession, getSession } from './db/index.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

interface FakeHandleControls {
  handle: SupervisedHandle;
  fireTerminal(): void;
  stopped: string[];
}

function fakeHandle(sessionId: string, name: string): FakeHandleControls {
  const terminalCallbacks: Array<(failure?: unknown) => void> = [];
  const stopped: string[] = [];
  const handle = {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId },
    name,
    async start() {},
    async stop(reason: string) {
      stopped.push(reason);
      for (const callback of terminalCallbacks) callback(undefined);
    },
    async status() {
      return { phase: 'running' };
    },
    onTerminal(callback: (failure?: unknown) => void) {
      terminalCallbacks.push(callback);
    },
  } as unknown as SupervisedHandle;
  return {
    handle,
    stopped,
    fireTerminal: () => {
      for (const callback of terminalCallbacks) callback(undefined);
    },
  };
}

async function seedSession(id = 'sess-1'): Promise<void> {
  await createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
}

beforeEach(async () => {
  snapshots.length = 0;
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await seedSession();
});

afterEach(async () => {
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  await closeDb();
});

describe('claim-fenced adoption', () => {
  it('losing the claim CAS skips adoption and leaves the container alone', async () => {
    // The CAS race itself is proven at the db layer (coordination.test.ts);
    // here we force the loss to pin the runner's abort behavior: no adoption,
    // no registry entry, and — critically — the container is NOT stopped,
    // because it belongs to whichever claimant won.
    const coordination = await import('./db/coordination.js');
    const casSpy = vi.spyOn(coordination, 'tryClaimSession').mockResolvedValueOnce(null);

    const controls = fakeHandle('sess-1', 'container-theirs');
    snapshots.push({ handle: controls.handle, phase: 'running' } as SupervisedSnapshot);

    const { adopted, stopped } = await adoptRunningSessions();
    casSpy.mockRestore();

    expect(adopted).toBe(0);
    expect(stopped).toBe(0);
    expect(isContainerRunning('sess-1')).toBe(false);
    expect(controls.stopped).toHaveLength(0);
  });

  it('a takeover of a crashed claimant still works: sequential claims win with a fresh read', async () => {
    // A dead process's claim must never wedge the session — a later claimant
    // reads the current incarnation and takes over. (Refusing claims held by
    // a LIVE process is the lease-liveness check that arrives when the
    // host-instance branch converges with this one.)
    await tryClaimSession({ sessionId: 'sess-1', instanceId: 'crashed-host:1', expectedIncarnation: 0, now: now() });

    const controls = fakeHandle('sess-1', 'container-adopted');
    snapshots.push({ handle: controls.handle, phase: 'running' } as SupervisedSnapshot);
    const { adopted } = await adoptRunningSessions();
    expect(adopted).toBe(1);
    const claim = await getSessionClaim('sess-1');
    expect(claim?.incarnation).toBe(2);
    expect(claim?.claimed_by).toMatch(/:\d+$/);
  });
});

describe('stale-finish fencing', () => {
  it('a finish from a superseded incarnation does not stomp the fresh claim or the session status', async () => {
    const controls = fakeHandle('sess-1', 'container-old');
    snapshots.push({ handle: controls.handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    expect((await getSessionClaim('sess-1'))?.incarnation).toBe(1);

    // A newer claimant (fresh spawn elsewhere) fences incarnation 1 out.
    await tryClaimSession({ sessionId: 'sess-1', instanceId: 'other-host:999', expectedIncarnation: 1, now: now() });

    const onExit = vi.fn();
    killContainer('sess-1', 'stale-kill', onExit);
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));

    // Status untouched (the fresh incarnation is running), callbacks skipped,
    // the newer claim intact.
    expect((await getSession('sess-1'))?.container_status).toBe('running');
    expect(onExit).not.toHaveBeenCalled();
    const claim = await getSessionClaim('sess-1');
    expect(claim?.claimed_by).toBe('other-host:999');
    expect(claim?.incarnation).toBe(2);
  });

  it('a terminal event from a replaced runtime never finalizes the current one', async () => {
    const old = fakeHandle('sess-1', 'container-old');
    snapshots.push({ handle: old.handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();

    // A second adoption pass replaces the registered runtime (same process,
    // fresh handle) without the old runtime ever finishing.
    snapshots.length = 0;
    const fresh = fakeHandle('sess-1', 'container-new');
    snapshots.push({ handle: fresh.handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    expect((await getSessionClaim('sess-1'))?.incarnation).toBe(2);

    // The old handle's late terminal event must resolve only itself.
    old.fireTerminal();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isContainerRunning('sess-1')).toBe(true);
    expect((await getSession('sess-1'))?.container_status).toBe('running');
    expect((await getSessionClaim('sess-1'))?.incarnation).toBe(2);
  });
});

describe('durable respawn intent', () => {
  it('honors respawn_after_stop for a session with no container, clearing it on a successful wake', async () => {
    await setStopIntent('sess-1', 'respawn_after_stop', now());
    const wake = vi.fn(async (_session: Session) => true);

    await honorPendingStopIntents(wake);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0].id).toBe('sess-1');
    expect((await getSessionClaim('sess-1'))?.stop_intent).toBeNull();
  });

  it('keeps the intent when the wake fails, for the next recovery pass', async () => {
    await setStopIntent('sess-1', 'respawn_after_stop', now());
    const wake = vi.fn(async (_session: Session) => false);

    await honorPendingStopIntents(wake);
    expect((await getSessionClaim('sess-1'))?.stop_intent).toBe('respawn_after_stop');
  });

  it('re-issues the interrupted kill when the container outlived the host, then respawns', async () => {
    const controls = fakeHandle('sess-1', 'container-survivor');
    snapshots.push({ handle: controls.handle, phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    await setStopIntent('sess-1', 'respawn_after_stop', now());

    const wake = vi.fn(async (_session: Session) => true);
    await honorPendingStopIntents(wake);

    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
    expect(controls.stopped).toContain('restart-intent-recovery');
    await vi.waitFor(async () => {
      expect(wake).toHaveBeenCalledTimes(1);
      expect((await getSessionClaim('sess-1'))?.stop_intent).toBeNull();
    });
  });

  it('clears an intent left on a closed session without waking anything', async () => {
    await seedSession('sess-closed');
    const db = (await import('./db/connection.js')).getDb();
    await db.run("UPDATE sessions SET status = 'closed' WHERE id = ?", 'sess-closed');
    await setStopIntent('sess-closed', 'respawn_after_stop', now());

    const wake = vi.fn(async (_session: Session) => true);
    await honorPendingStopIntents(wake);
    expect(wake).not.toHaveBeenCalled();
    expect((await getSessionClaim('sess-closed'))?.stop_intent).toBeNull();
  });
});
