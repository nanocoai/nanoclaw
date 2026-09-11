/**
 * Claimant liveness: a session claim held by a LIVE peer host (unexpired,
 * unstopped host_instances lease) is refused; claims held by stopped,
 * expired, or unknown claimants stay takeover-able — a crashed claimant must
 * never wedge a session. Also pins the claimant identity: the durable lease
 * instance id when the lease is running, the process-scoped fallback
 * otherwise.
 */
import os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';

const snapshots: SupervisedSnapshot[] = [];
vi.mock('./drivers/index.js', () => ({
  getSessionDriver: () => ({
    listSessions: async () => snapshots,
    capabilities: () => ({}),
  }),
  peekSessionDriver: () => null,
  isSessionEventsDriver: () => false,
}));

import { adoptRunningSessions, isContainerRunning, killContainer } from './container-runner.js';
import { getSessionClaim, registerHostInstance, tryClaimSession } from './db/coordination.js';
import { startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';

function now(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function fakeRunningHandle(sessionId: string, name: string): SupervisedSnapshot {
  const handle = {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId },
    name,
    async start() {},
    async stop() {},
    async status() {
      return { phase: 'running' };
    },
    onTerminal() {},
  } as unknown as SupervisedHandle;
  return { handle, phase: 'running' } as SupervisedSnapshot;
}

const FALLBACK_ID = `${os.hostname()}:${process.pid}`;

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
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(async () => {
  await stopHostInstanceLease();
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  await closeDb();
});

describe('claimant liveness', () => {
  it('refuses to take over a claim held by a live peer host', async () => {
    await registerHostInstance({ instanceId: 'peer-live', installId: 'x', now: now(), leaseExpiresAt: now(90_000) });
    await tryClaimSession({ sessionId: 'sess-1', instanceId: 'peer-live', expectedIncarnation: 0, now: now() });

    snapshots.push(fakeRunningHandle('sess-1', 'container-theirs'));
    const { adopted, stopped } = await adoptRunningSessions();

    expect(adopted).toBe(0);
    expect(stopped).toBe(0);
    expect(isContainerRunning('sess-1')).toBe(false);
    const claim = await getSessionClaim('sess-1');
    expect(claim?.claimed_by).toBe('peer-live');
    expect(claim?.incarnation).toBe(1);
  });

  it('takes over when the holder lease is expired', async () => {
    await registerHostInstance({
      instanceId: 'peer-dead',
      installId: 'x',
      now: now(-120_000),
      leaseExpiresAt: now(-30_000),
    });
    await tryClaimSession({ sessionId: 'sess-1', instanceId: 'peer-dead', expectedIncarnation: 0, now: now() });

    snapshots.push(fakeRunningHandle('sess-1', 'container-orphaned'));
    const { adopted } = await adoptRunningSessions();

    expect(adopted).toBe(1);
    const claim = await getSessionClaim('sess-1');
    expect(claim?.incarnation).toBe(2);
    expect(claim?.claimed_by).toBe(FALLBACK_ID);
  });

  it('takes over when the claimant id is unknown to host_instances', async () => {
    await tryClaimSession({ sessionId: 'sess-1', instanceId: 'legacy-host:42', expectedIncarnation: 0, now: now() });

    snapshots.push(fakeRunningHandle('sess-1', 'container-legacy'));
    const { adopted } = await adoptRunningSessions();

    expect(adopted).toBe(1);
    expect((await getSessionClaim('sess-1'))?.incarnation).toBe(2);
  });

  it('re-claims its own held claim without a liveness refusal', async () => {
    // Our own fallback id, registered live — self re-claim must not be
    // refused even though the holder is a live instance.
    await registerHostInstance({ instanceId: FALLBACK_ID, installId: 'x', now: now(), leaseExpiresAt: now(90_000) });
    await tryClaimSession({ sessionId: 'sess-1', instanceId: FALLBACK_ID, expectedIncarnation: 0, now: now() });

    snapshots.push(fakeRunningHandle('sess-1', 'container-ours'));
    const { adopted } = await adoptRunningSessions();

    expect(adopted).toBe(1);
    const claim = await getSessionClaim('sess-1');
    expect(claim?.incarnation).toBe(2);
    expect(claim?.claimed_by).toBe(FALLBACK_ID);
  });

  it('claims as the lease instance id while the host lease is running', async () => {
    const leaseId = await startHostInstanceLease();

    snapshots.push(fakeRunningHandle('sess-1', 'container-leased'));
    const { adopted } = await adoptRunningSessions();

    expect(adopted).toBe(1);
    expect((await getSessionClaim('sess-1'))?.claimed_by).toBe(leaseId);
  });
});
