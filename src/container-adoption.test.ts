/**
 * Startup adoption — the reconciliation of DB `container_status` against what
 * the session runtime actually still has.
 *
 * The case that matters here is the absent one: a container that died while no
 * host was attached never appears in `listSessions`, so the adoption loop never
 * visits its row. `container_status` is only ever cleared by the in-process
 * exit handler, which that container outlived — so without a clearing pass the
 * row reads 'running' forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adoptRunningSessions } from './container-runner.js';
import { getRunningSessions, getSession } from './db/sessions.js';
import { getSessionDriver } from './drivers/index.js';
import { markContainerRunning, markContainerStopped } from './session-manager.js';
import type { Session } from './types.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./db/sessions.js', () => ({ getSession: vi.fn(), getRunningSessions: vi.fn() }));
vi.mock('./drivers/index.js', () => ({
  getSessionDriver: vi.fn(),
  isSessionEventsDriver: () => false,
}));
vi.mock('./session-manager.js', () => ({
  markContainerRunning: vi.fn(),
  markContainerStopped: vi.fn(),
  heartbeatPath: vi.fn(),
  sessionContextPath: vi.fn(),
  sessionDir: vi.fn(),
  writeSessionContext: vi.fn(),
  writeSessionRouting: vi.fn(),
}));

function session(id: string): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    status: 'active',
    container_status: 'running',
    last_active: '2026-08-19T19:50:06.786Z',
    created_at: '2026-08-19T19:50:06.786Z',
  } as Session;
}

function snapshot(sessionId: string, phase: 'running' | 'terminal') {
  return {
    phase,
    handle: {
      name: `nanoclaw-${sessionId}`,
      key: { installSlug: 'slug', agentGroupId: 'ag-1', sessionId },
      stop: vi.fn().mockResolvedValue(undefined),
      onTerminal: vi.fn(),
    },
  };
}

describe('adoptRunningSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockImplementation(async (id: string) => session(id));
    vi.mocked(getRunningSessions).mockResolvedValue([]);
  });

  it('clears container_status for a session the runtime no longer lists', async () => {
    vi.mocked(getSessionDriver).mockReturnValue({
      listSessions: vi.fn().mockResolvedValue([]),
    } as never);
    vi.mocked(getRunningSessions).mockResolvedValue([session('sess-gone')]);

    const result = await adoptRunningSessions();

    expect(result.cleared).toBe(1);
    expect(markContainerStopped).toHaveBeenCalledWith('sess-gone');
  });

  it('leaves an adopted session marked running', async () => {
    vi.mocked(getSessionDriver).mockReturnValue({
      listSessions: vi.fn().mockResolvedValue([snapshot('sess-alive', 'running')]),
    } as never);
    // The DB still lists it as running — the clearing pass must skip it.
    vi.mocked(getRunningSessions).mockResolvedValue([session('sess-alive')]);

    const result = await adoptRunningSessions();

    expect(result).toMatchObject({ adopted: 1, cleared: 0 });
    expect(markContainerRunning).toHaveBeenCalledWith('sess-alive');
    expect(markContainerStopped).not.toHaveBeenCalled();
  });

  it('clears a session whose listed container is already terminal', async () => {
    vi.mocked(getSessionDriver).mockReturnValue({
      listSessions: vi.fn().mockResolvedValue([snapshot('sess-dead', 'terminal')]),
    } as never);
    vi.mocked(getRunningSessions).mockResolvedValue([session('sess-dead')]);

    const result = await adoptRunningSessions();

    expect(result).toMatchObject({ adopted: 0, stopped: 1, cleared: 1 });
    expect(markContainerStopped).toHaveBeenCalledWith('sess-dead');
  });
});
