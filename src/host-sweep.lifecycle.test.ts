import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./reconcile-session.js', () => ({
  reconcileSession: vi.fn(),
  ABSOLUTE_CEILING_MS: 0,
  CLAIM_STUCK_MS: 0,
  _resetStuckProcessingRowsForTesting: vi.fn(),
  decideStuckAction: vi.fn(),
  shouldCloseTaskSession: vi.fn(),
}));
vi.mock('./db/sessions.js', () => ({
  getActiveSessions: vi.fn(),
  // The approvals re-export may already be loaded by the runtime composition.
  getExpiredAwaitingReasonApprovals: vi.fn(async () => []),
}));
vi.mock('./egress-lockdown.js', () => ({ ensureEgressNetwork: vi.fn() }));
vi.mock('./modules/approvals/index.js', () => ({ sweepAwaitingReasonRejects: vi.fn() }));
vi.mock('./container-runner.js', () => ({ stopOrphanedSessions: vi.fn(), retryPendingAdoptions: vi.fn() }));
vi.mock('./drivers/index.js', () => ({ peekSessionDriver: vi.fn(() => null) }));
// Observe the real queue; do not replace its admission or drain behavior.
vi.mock('./reconcile-queue.js', async (importActual) => {
  const actual = await importActual<typeof import('./reconcile-queue.js')>();
  return { ...actual, createReconcileQueue: vi.fn(actual.createReconcileQueue) };
});

import { retryPendingAdoptions, stopOrphanedSessions } from './container-runner.js';
import { getActiveSessions } from './db/sessions.js';
import { peekSessionDriver } from './drivers/index.js';
import type { SessionEvent } from './drivers/types.js';
import { enqueueSessionReconcile } from './reconcile-feeds.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { sweepAwaitingReasonRejects } from './modules/approvals/index.js';
import { createReconcileQueue } from './reconcile-queue.js';
import { reconcileSession } from './reconcile-session.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const realSetTimeout = global.setTimeout;
let timers: Array<{ callback: () => void; handle: NodeJS.Timeout }>;
let scheduled: ReturnType<typeof deferred<void>>;
let releaseListing: (() => void) | undefined;
let releaseWork: (() => void) | undefined;
let stopResults: Promise<PromiseSettledResult<void>[]> | undefined;

function queueAt(index: number) {
  return vi.mocked(createReconcileQueue).mock.results[index].value as ReturnType<typeof createReconcileQueue>;
}

beforeEach(() => {
  timers = [];
  scheduled = deferred();
  releaseListing = undefined;
  releaseWork = undefined;
  vi.mocked(peekSessionDriver).mockReset().mockReturnValue(null);
  stopResults = undefined;
  vi.mocked(createReconcileQueue).mockClear();
  vi.mocked(getActiveSessions).mockReset().mockResolvedValue([]);
  vi.mocked(reconcileSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(sweepAwaitingReasonRejects).mockReset().mockResolvedValue(undefined);
  vi.mocked(stopOrphanedSessions).mockReset().mockResolvedValue(0);
  vi.mocked(retryPendingAdoptions).mockReset().mockResolvedValue(undefined);
  // Capture only sweep timers: no wall-clock sleeps or periodic callbacks run.
  vi.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, ms?: number) => {
    if (ms !== 60_000) return realSetTimeout(callback, ms);
    const handle = { diagnosticTimer: timers.length } as unknown as NodeJS.Timeout;
    timers.push({ callback, handle });
    scheduled.resolve();
    return handle;
  }) as typeof setTimeout);
  vi.spyOn(global, 'clearTimeout');
});

afterEach(async () => {
  // Release the held listing even if an assertion failed before its normal release.
  releaseListing?.();
  releaseWork?.();
  await stopHostSweep();
  await stopResults;
  const queues = vi.mocked(createReconcileQueue).mock.results;
  await Promise.all(queues.map((_, index) => queueAt(index).idle()));
  vi.restoreAllMocks();
});

describe('host sweep lifecycle', () => {
  it('drains in-flight reconciliation across concurrent stops without draining a later start', async () => {
    const entered = deferred();
    const work = deferred();
    releaseWork = () => work.resolve();
    vi.mocked(getActiveSessions).mockResolvedValueOnce([{ id: 'old' }] as Awaited<
      ReturnType<typeof getActiveSessions>
    >);
    vi.mocked(reconcileSession).mockImplementationOnce(async () => {
      entered.resolve();
      await work.promise;
    });
    startHostSweep();
    await entered.promise;
    let firstDone = false;
    let secondDone = false;
    const first = Promise.resolve(stopHostSweep()).then(() => {
      firstDone = true;
    });
    const second = Promise.resolve(stopHostSweep()).then(() => {
      secondDone = true;
    });
    stopResults = Promise.allSettled([first, second]);
    startHostSweep();
    await scheduled.promise;
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);
    work.resolve();
    expect((await stopResults).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
    expect(timers).toHaveLength(1);
  });

  it('cancels an armed timer and ignores its stale callback after restart', async () => {
    startHostSweep();
    await scheduled.promise;
    const stale = timers[0];
    await stopHostSweep();
    expect(clearTimeout).toHaveBeenCalledWith(stale.handle);
    scheduled = deferred();
    startHostSweep();
    await scheduled.promise;
    const calls = vi.mocked(getActiveSessions).mock.calls.length;
    stale.callback();
    await queueAt(1).idle();
    expect(getActiveSessions).toHaveBeenCalledTimes(calls);
    expect(timers).toHaveLength(2);
  });

  it('drops old watch events after restart but admits current watch and explicit feeds', async () => {
    const handlers: Array<(event: SessionEvent) => void> = [];
    const stops = [vi.fn(), vi.fn()];
    vi.mocked(peekSessionDriver).mockReturnValue({
      watchSessions: (_slug: string, handler: (event: SessionEvent) => void) => {
        const stop = stops[handlers.length];
        handlers.push(handler);
        return { stop };
      },
    } as unknown as ReturnType<typeof peekSessionDriver>);
    const terminal = (sessionId: string): SessionEvent => ({
      kind: 'terminal',
      key: { installSlug: 'test', agentGroupId: 'g', sessionId },
    });
    startHostSweep();
    await scheduled.promise;
    await stopHostSweep();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    scheduled = deferred();
    startHostSweep();
    await scheduled.promise;
    handlers[0](terminal('stale'));
    handlers[1](terminal('current-watch'));
    enqueueSessionReconcile('current-feed');
    await queueAt(1).idle();
    expect(vi.mocked(reconcileSession).mock.calls.map(([id]) => id)).toEqual(['current-watch', 'current-feed']);
  });

  it.each(['resolve', 'reject'] as const)(
    'drains an old listing that later %ss across concurrent stops and restart',
    async (outcome) => {
      const entered = deferred();
      const listing = deferred<Awaited<ReturnType<typeof getActiveSessions>>>();
      releaseListing = () => listing.resolve([]);
      vi.mocked(getActiveSessions).mockImplementationOnce(() => {
        entered.resolve();
        return listing.promise;
      });
      startHostSweep();
      await entered.promise;
      const oldAdds = vi.spyOn(queueAt(0), 'add');
      let firstDone = false;
      let secondDone = false;
      const first = Promise.resolve(stopHostSweep()).then(() => {
        firstDone = true;
      });
      const second = Promise.resolve(stopHostSweep()).then(() => {
        secondDone = true;
      });
      // Attach rejection handlers immediately, including the assertion-failure path.
      stopResults = Promise.allSettled([first, second]);
      startHostSweep();
      await scheduled.promise; // Positive completion of the independent new tick.
      expect(firstDone).toBe(false);
      expect(secondDone).toBe(false);

      if (outcome === 'resolve') {
        listing.resolve([{ id: 'old-session' }] as Awaited<ReturnType<typeof getActiveSessions>>);
      } else {
        listing.reject(new Error('listing failed while stopping'));
      }
      expect((await stopResults).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      await queueAt(0).idle();
      expect(firstDone).toBe(true);
      expect(secondDone).toBe(true);
      expect(oldAdds).not.toHaveBeenCalled();
      expect(reconcileSession).not.toHaveBeenCalled();
      expect(timers).toHaveLength(1); // Only the new generation may rearm.
      expect(stopOrphanedSessions).toHaveBeenCalledTimes(1);
      expect(retryPendingAdoptions).toHaveBeenCalledTimes(1); // Preserve rc.1's added duty.
    },
  );
});
