import { afterEach, expect, it, vi } from 'vitest';

import {
  boundedAdoptedEgress,
  NULL_SESSION_EGRESS,
  prepareSessionEgress,
  registerSessionEgressFactory,
} from './session-egress.js';
import type { AgentGroup, Session } from './types.js';

const agentGroup: AgentGroup = {
  id: 'agent-1',
  name: 'Agent One',
  folder: 'agent-one',
  agent_provider: null,
  created_at: '2026-07-22T00:00:00.000Z',
};

const session: Session = {
  id: 'session-1',
  agent_group_id: agentGroup.id,
  messaging_group_id: 'messaging-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-07-22T00:00:00.000Z',
};

it('fails closed when NanoCo session egress has not been registered', async () => {
  await expect(prepareSessionEgress({ session, agentGroup, containerName: 'agent-container-1' })).rejects.toThrow(
    'NanoCo session egress is not configured',
  );
});
it('passes the Host-minted request capability to the egress factory', async () => {
  const factory = vi.fn(async () => NULL_SESSION_EGRESS);
  registerSessionEgressFactory(factory);
  const requestCapability = 'a'.repeat(64);

  await prepareSessionEgress({ session, agentGroup, containerName: 'agent-container-1', requestCapability });

  expect(factory).toHaveBeenCalledWith({ session, agentGroup, containerName: 'agent-container-1', requestCapability });
});

afterEach(() => {
  vi.useRealTimers();
});

it('bounds an adopted session without a re-adopted lease at the horizon', async () => {
  // The D4 floor: an adopted session with mediated egress has a bounded
  // lifetime. This handle is what a runtime carries when lease re-adoption is
  // unavailable — its onUnavailable MUST fire, or the session zombies (pod
  // Running, egress dead, nothing noticing).
  vi.useFakeTimers();
  const handle = boundedAdoptedEgress(1_000);
  const unavailable = vi.fn();
  handle.onUnavailable(unavailable);

  await vi.advanceTimersByTimeAsync(999);
  expect(unavailable).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(unavailable).toHaveBeenCalledTimes(1);
});

it('delivers the horizon to a callback wired after it passed', async () => {
  // Adoption wires onUnavailable after registration; a horizon that fires in
  // between must not be lost.
  vi.useFakeTimers();
  const handle = boundedAdoptedEgress(1_000);
  await vi.advanceTimersByTimeAsync(1_000);

  const unavailable = vi.fn();
  handle.onUnavailable(unavailable);
  expect(unavailable).toHaveBeenCalledTimes(1);
});

it('close and detach both cancel the horizon', async () => {
  vi.useFakeTimers();
  for (const end of ['close', 'detach'] as const) {
    const handle = boundedAdoptedEgress(1_000);
    const unavailable = vi.fn();
    handle.onUnavailable(unavailable);

    await (end === 'close' ? handle.close('ended') : handle.detach());
    await vi.advanceTimersByTimeAsync(10_000);

    expect(unavailable, end).not.toHaveBeenCalled();
  }
});
