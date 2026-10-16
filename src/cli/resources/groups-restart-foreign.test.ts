/**
 * #3911 — `ncl groups restart --id <other group>` from an agent (global
 * scope, after approval) must restart the target group, not the caller.
 *
 * Calls the registered handler directly: the guard and the approval replay
 * are covered elsewhere; this pins which containers the handler touches.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockResolvedValue(2),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { killContainer } from '../../container-runner.js';
import { restartAgentGroupContainers } from '../../container-restart.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { CallerContext } from '../frame.js';
import { lookup } from '../registry.js';
// Side-effect import: registers the `groups-*` commands (including restart).
import './groups.js';

const caller: CallerContext = { caller: 'agent', sessionId: 'sess-a', agentGroupId: 'ag-a', messagingGroupId: 'mg-a' };

function restart(args: Record<string, unknown>) {
  const cmd = lookup('groups-restart');
  if (!cmd) throw new Error('groups-restart not registered');
  return cmd.handler(args, caller);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('groups restart from an agent', () => {
  it('restarts only the calling session when --id is its own group', async () => {
    const res = await restart({ id: 'ag-a' });

    expect(res).toEqual({ restarted: 1, rebuilt: false });
    expect(killContainer).toHaveBeenCalledWith('sess-a', 'restarted via ncl', undefined);
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it('restarts the target group, not the caller, for a foreign --id (#3911)', async () => {
    const res = await restart({ id: 'ag-b', message: 'check in' });

    expect(res).toEqual({ restarted: 2, rebuilt: false });
    expect(restartAgentGroupContainers).toHaveBeenCalledWith('ag-b', 'restarted via ncl', 'check in');
    expect(killContainer).not.toHaveBeenCalled();
    // No orphan on-wake row under <target group>/<caller session>.
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });
});
