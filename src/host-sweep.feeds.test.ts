/**
 * The event feeds: runtime terminal events and explicit enqueues land on the
 * sweep's workqueue between ticks — behavior gets faster, never different.
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
vi.mock('./drivers/index.js', () => ({ peekSessionDriver: vi.fn(() => null) }));

import { getActiveSessions } from './db/sessions.js';
import { peekSessionDriver } from './drivers/index.js';
import type { SessionEvent } from './drivers/types.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { enqueueSessionReconcile } from './reconcile-feeds.js';
import { reconcileSession } from './reconcile-session.js';

const SWEEP_INTERVAL_MS = 60_000;
const sweepCallbacks: Array<() => void> = [];
const realSetTimeout = global.setTimeout;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

let watchHandler: ((event: SessionEvent) => void) | null = null;
const watchStop = vi.fn();

function fakeWatchingDriver(): ReturnType<typeof peekSessionDriver> {
  return {
    watchSessions: (_slug: string, onEvent: (event: SessionEvent) => void) => {
      watchHandler = onEvent;
      return { stop: watchStop };
    },
  } as unknown as ReturnType<typeof peekSessionDriver>;
}

function terminalEvent(sessionId: string): SessionEvent {
  return { kind: 'terminal', key: { installSlug: 'inst', agentGroupId: 'g-1', sessionId } };
}

async function startAndDrainFirstTick(): Promise<void> {
  startHostSweep();
  await vi.waitFor(() => {
    expect(sweepCallbacks.length).toBe(1);
  });
}

beforeEach(() => {
  watchHandler = null;
  watchStop.mockReset();
  vi.mocked(peekSessionDriver).mockReset().mockReturnValue(null);
  vi.mocked(reconcileSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(getActiveSessions).mockReset().mockResolvedValue([]);

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

describe('runtime terminal-event feed', () => {
  it('a terminal event reconciles the session without waiting for a tick', async () => {
    vi.mocked(peekSessionDriver).mockReturnValue(fakeWatchingDriver());
    await startAndDrainFirstTick();
    expect(watchHandler).not.toBeNull();
    expect(reconcileSession).not.toHaveBeenCalled();

    watchHandler!(terminalEvent('s-9'));
    await vi.waitFor(() => {
      expect(reconcileSession).toHaveBeenCalledWith('s-9');
    });
  });

  it('ignores non-terminal events and keys without a session id', async () => {
    vi.mocked(peekSessionDriver).mockReturnValue(fakeWatchingDriver());
    await startAndDrainFirstTick();

    watchHandler!({ kind: 'phase', key: { installSlug: 'inst', agentGroupId: 'g-1', sessionId: 's-9' } });
    watchHandler!({ kind: 'terminal', key: { installSlug: 'inst', agentGroupId: 'g-1', sessionId: '' } });
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    expect(reconcileSession).not.toHaveBeenCalled();
  });

  it('arms nothing when no driver has been selected', async () => {
    await startAndDrainFirstTick();
    expect(watchHandler).toBeNull();
  });

  it('stops the watch and drops feed enqueues once the sweep stops', async () => {
    vi.mocked(peekSessionDriver).mockReturnValue(fakeWatchingDriver());
    await startAndDrainFirstTick();
    const handler = watchHandler!;

    stopHostSweep();
    expect(watchStop).toHaveBeenCalledTimes(1);

    handler(terminalEvent('s-9'));
    enqueueSessionReconcile('s-9');
    await new Promise((resolve) => realSetTimeout(resolve, 20));
    expect(reconcileSession).not.toHaveBeenCalled();
  });

  it('a burst of events for one session coalesces to at most one rerun', async () => {
    vi.mocked(peekSessionDriver).mockReturnValue(fakeWatchingDriver());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(reconcileSession).mockImplementation(async () => gate);
    await startAndDrainFirstTick();

    for (let i = 0; i < 5; i += 1) watchHandler!(terminalEvent('s-9'));
    await vi.waitFor(() => {
      expect(reconcileSession).toHaveBeenCalledTimes(1);
    });
    release();
    // The adds that landed mid-run collapse into a single dirty rerun.
    await new Promise((resolve) => realSetTimeout(resolve, 30));
    expect(vi.mocked(reconcileSession).mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('explicit enqueue feed', () => {
  it('an enqueue between ticks reconciles the session promptly', async () => {
    await startAndDrainFirstTick();
    enqueueSessionReconcile('s-3');
    await vi.waitFor(() => {
      expect(reconcileSession).toHaveBeenCalledWith('s-3');
    });
  });
});
