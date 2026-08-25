/**
 * The sweep drives the keyed workqueue: each tick enqueues the singleton
 * duties and every active session, runs each exactly once in the loop's
 * long-standing order, and re-arms only after the tick's work has drained.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./reconcile-session.js', () => ({
  reconcileSession: vi.fn(),
  // Re-exported surface host-sweep.ts forwards — inert stubs.
  ABSOLUTE_CEILING_MS: 0,
  CLAIM_STUCK_MS: 0,
  _resetStuckProcessingRowsForTesting: vi.fn(),
  decideStuckAction: vi.fn(),
  shouldCloseTaskSession: vi.fn(),
}));
vi.mock('./db/sessions.js', () => ({ getActiveSessions: vi.fn() }));
vi.mock('./egress-lockdown.js', () => ({ ensureEgressNetwork: vi.fn() }));
vi.mock('./modules/approvals/index.js', () => ({ sweepAwaitingReasonRejects: vi.fn() }));

import { getActiveSessions } from './db/sessions.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { sweepAwaitingReasonRejects } from './modules/approvals/index.js';
import { reconcileSession } from './reconcile-session.js';

const SWEEP_INTERVAL_MS = 60_000;
const sweepCallbacks: Array<() => void> = [];
const realSetTimeout = global.setTimeout;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
let order: string[] = [];

async function runSweepTick(): Promise<void> {
  const before = sweepCallbacks.length;
  if (before === 0) startHostSweep();
  else sweepCallbacks[before - 1]();
  await vi.waitFor(() => {
    expect(sweepCallbacks.length).toBe(before + 1);
  });
}

beforeEach(() => {
  order = [];
  vi.mocked(reconcileSession)
    .mockReset()
    .mockImplementation(async (id: string) => {
      order.push(`session:${id}`);
    });
  vi.mocked(ensureEgressNetwork)
    .mockReset()
    .mockImplementation(() => {
      order.push('egress');
      return true;
    });
  vi.mocked(sweepAwaitingReasonRejects)
    .mockReset()
    .mockImplementation(async () => {
      order.push('approvals');
    });
  vi.mocked(getActiveSessions)
    .mockReset()
    .mockResolvedValue([{ id: 's-1' }, { id: 's-2' }] as Awaited<ReturnType<typeof getActiveSessions>>);

  sweepCallbacks.length = 0;
  setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === SWEEP_INTERVAL_MS) {
      sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
});

afterEach(() => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
});

describe('sweep over the workqueue', () => {
  it('reconciles each active session exactly once per tick, in order, then re-arms', async () => {
    await runSweepTick();

    expect(reconcileSession).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['egress', 'session:s-1', 'session:s-2', 'approvals']);

    await runSweepTick();
    expect(reconcileSession).toHaveBeenCalledTimes(4);
  });

  it('a session listing failure still runs the singleton duties and re-arms', async () => {
    vi.mocked(getActiveSessions).mockRejectedValueOnce(new Error('db down'));
    await runSweepTick();

    expect(reconcileSession).not.toHaveBeenCalled();
    expect(ensureEgressNetwork).toHaveBeenCalledTimes(1);
    expect(sweepAwaitingReasonRejects).toHaveBeenCalledTimes(1);

    // Next tick recovers.
    await runSweepTick();
    expect(reconcileSession).toHaveBeenCalledTimes(2);
  });

  it('a throwing per-session reconcile does not block the rest of the tick', async () => {
    vi.mocked(reconcileSession).mockImplementation(async (id: string) => {
      if (id === 's-1') throw new Error('boom');
      order.push(`session:${id}`);
    });

    await runSweepTick();
    // s-2 and the closing singleton still ran; the tick completed and re-armed.
    expect(order).toEqual(['egress', 'session:s-2', 'approvals']);
  });
});
