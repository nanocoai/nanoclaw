/**
 * Session-claim writes through the real lifecycle: adoption claims a session
 * (incarnation bump + CAS), finalization releases the claim. (Originally
 * written for the shadow phase; the rows are now the fencing authority and
 * every assertion carried unchanged.)
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

import { adoptRunningSessions, isContainerRunning, killContainer } from './container-runner.js';
import { getSessionClaim } from './db/coordination.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';

function now(): string {
  return new Date().toISOString();
}

function fakeHandle(sessionId: string, name: string): SupervisedHandle {
  const terminalCallbacks: Array<(failure?: unknown) => void> = [];
  return {
    key: { installSlug: 'test-install', agentGroupId: 'ag-1', sessionId },
    name,
    async start() {},
    async stop() {
      for (const callback of terminalCallbacks) callback(undefined);
    },
    async status() {
      return { phase: 'running' };
    },
    onTerminal(callback: (failure?: unknown) => void) {
      terminalCallbacks.push(callback);
    },
  } as unknown as SupervisedHandle;
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
  // Drain any runtime left registered so cross-test state cannot leak.
  if (isContainerRunning('sess-1')) {
    killContainer('sess-1', 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning('sess-1')).toBe(false));
  }
  await closeDb();
});

describe('session claim lifecycle', () => {
  it('adoption shadow-claims the session and finalization releases it', async () => {
    snapshots.push({ handle: fakeHandle('sess-1', 'container-a'), phase: 'running' } as SupervisedSnapshot);
    const { adopted } = await adoptRunningSessions();
    expect(adopted).toBe(1);

    const claim = await getSessionClaim('sess-1');
    expect(claim?.incarnation).toBe(1);
    expect(claim?.claimed_by).toMatch(/:\d+$/);
    expect(claim?.container_ref).toBe('container-a');

    killContainer('sess-1', 'test-stop');
    await vi.waitFor(async () => {
      const released = await getSessionClaim('sess-1');
      expect(released?.claimed_by).toBeNull();
      expect(released?.incarnation).toBe(1);
    });
  });

  it('a re-adopted session bumps the incarnation via CAS', async () => {
    snapshots.push({ handle: fakeHandle('sess-1', 'container-a'), phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    killContainer('sess-1', 'test-stop');
    await vi.waitFor(async () => expect((await getSessionClaim('sess-1'))?.claimed_by).toBeNull());

    snapshots.length = 0;
    snapshots.push({ handle: fakeHandle('sess-1', 'container-b'), phase: 'running' } as SupervisedSnapshot);
    await adoptRunningSessions();
    const claim = await getSessionClaim('sess-1');
    expect(claim?.incarnation).toBe(2);
    expect(claim?.container_ref).toBe('container-b');
  });
});
