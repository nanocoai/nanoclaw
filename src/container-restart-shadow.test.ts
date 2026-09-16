/**
 * Restart shadow writes: a kill with a planned respawn records a durable
 * `respawn_after_stop` intent before the kill and clears it once the respawn
 * request has been made. The on_wake mechanism stays authoritative.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const killContainer = vi.fn();
vi.mock('./container-runner.js', () => ({
  isContainerRunning: vi.fn().mockReturnValue(true),
  killContainer: (sessionId: string, reason: string, onExit?: () => void) => killContainer(sessionId, reason, onExit),
}));

const requestWake = vi.fn().mockResolvedValue(true);
vi.mock('./request-wake.js', () => ({
  requestWake: (session: unknown, reason: string) => requestWake(session, reason),
}));

vi.mock('./session-manager.js', () => ({
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
  withExistingMailboxSession: vi.fn().mockResolvedValue(undefined),
}));

import { restartAgentGroupContainers } from './container-restart.js';
import { getSessionClaim } from './db/coordination.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, createSession } from './db/index.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  killContainer.mockClear();
  requestWake.mockClear();
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
  await closeDb();
});

describe('restart respawn intent', () => {
  it('writes respawn_after_stop before the kill and clears it after the respawn request', async () => {
    const restarted = await restartAgentGroupContainers('ag-1', 'test-restart', 'back online');
    expect(restarted).toBe(1);

    // The kill has happened but the (captured) exit callback has not fired:
    // the durable intent must already be in place.
    expect((await getSessionClaim('sess-1'))?.stop_intent).toBe('respawn_after_stop');
    const [sessionId, , onExit] = killContainer.mock.calls[0] as [string, string, () => void];
    expect(sessionId).toBe('sess-1');
    expect(onExit).toBeTypeOf('function');

    onExit();
    await vi.waitFor(async () => {
      expect(requestWake).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }), 'container-restart');
      expect((await getSessionClaim('sess-1'))?.stop_intent).toBeNull();
    });
  });

  it('writes no intent when no respawn is planned', async () => {
    const restarted = await restartAgentGroupContainers('ag-1', 'plain-stop');
    expect(restarted).toBe(1);
    expect(await getSessionClaim('sess-1')).toBeUndefined();
    const [, , onExit] = killContainer.mock.calls[0] as [string, string, (() => void) | undefined];
    expect(onExit).toBeUndefined();
  });
});
