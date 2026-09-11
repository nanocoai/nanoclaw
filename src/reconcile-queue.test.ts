import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createReconcileQueue } from './reconcile-queue.js';
import { sessionKey, type SingletonKey } from './reconcile.js';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const noopSingletons: Record<SingletonKey, () => Promise<void>> = {
  'singleton:egress-reheal': async () => {},
  'singleton:approvals-scan': async () => {},
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconcile queue', () => {
  it('coalesces adds for a waiting key into one run', async () => {
    const runs: string[] = [];
    const gate = deferred();
    const queue = createReconcileQueue({
      reconcile: async (id) => {
        runs.push(id);
        if (runs.length === 1) await gate.promise; // hold the first run so later adds land while s-2 waits
      },
      singletons: noopSingletons,
    });

    queue.add(sessionKey('s-1'));
    queue.add(sessionKey('s-2'));
    queue.add(sessionKey('s-2'));
    queue.add(sessionKey('s-2'));
    gate.resolve();
    await queue.idle();

    expect(runs).toEqual(['s-1', 's-2']);
  });

  it('re-runs a key that was re-added while it was running', async () => {
    const runs: string[] = [];
    const firstRun = deferred();
    const queue: ReturnType<typeof createReconcileQueue> = createReconcileQueue({
      reconcile: async (id) => {
        runs.push(id);
        if (runs.length === 1) {
          queue.add(sessionKey('s-1')); // state changed mid-reconcile
          firstRun.resolve();
        }
      },
      singletons: noopSingletons,
    });

    queue.add(sessionKey('s-1'));
    await firstRun.promise;
    await queue.idle();

    expect(runs).toEqual(['s-1', 's-1']);
  });

  it('addAfter keeps the earliest due time and is superseded by add', async () => {
    const runs: string[] = [];
    const queue = createReconcileQueue({
      reconcile: async (id) => {
        runs.push(id);
      },
      singletons: noopSingletons,
    });

    // Later reschedule must not push the due time back.
    queue.addAfter(sessionKey('s-1'), 1_000);
    queue.addAfter(sessionKey('s-1'), 10_000);
    await vi.advanceTimersByTimeAsync(1_100);
    await queue.idle();
    expect(runs).toEqual(['s-1']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs).toEqual(['s-1']); // the 10s schedule was coalesced away

    // A plain add supersedes a pending delay entirely.
    queue.addAfter(sessionKey('s-2'), 30_000);
    queue.add(sessionKey('s-2'));
    await queue.idle();
    expect(runs).toEqual(['s-1', 's-2']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(['s-1', 's-2']);
  });

  it('backs off a throwing key without holding up others, and recovers', async () => {
    const attempts: Record<string, number> = { 's-bad': 0, 's-good': 0 };
    const queue = createReconcileQueue({
      reconcile: async (id) => {
        attempts[id]++;
        if (id === 's-bad' && attempts[id] < 3) throw new Error('transient');
      },
      singletons: noopSingletons,
    });

    queue.add(sessionKey('s-bad'));
    queue.add(sessionKey('s-good'));
    await queue.idle();
    // The failure never blocked the healthy key.
    expect(attempts['s-good']).toBe(1);
    expect(attempts['s-bad']).toBe(1);

    // First retry at 5s, second at 10s; the third attempt succeeds.
    await vi.advanceTimersByTimeAsync(5_000);
    await queue.idle();
    expect(attempts['s-bad']).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await queue.idle();
    expect(attempts['s-bad']).toBe(3);

    // Recovered: no further retries pending.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts['s-bad']).toBe(3);
  });

  it('runs keys serially at the default concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = createReconcileQueue({
      reconcile: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
      },
      singletons: noopSingletons,
    });

    for (const id of ['a', 'b', 'c', 'd']) queue.add(sessionKey(id));
    await queue.idle();
    expect(maxInFlight).toBe(1);
  });

  it('shutdown lets the in-flight run finish and drops everything pending', async () => {
    const runs: string[] = [];
    const gate = deferred();
    const queue = createReconcileQueue({
      reconcile: async (id) => {
        runs.push(id);
        if (id === 'slow') await gate.promise;
      },
      singletons: noopSingletons,
    });

    queue.add(sessionKey('slow'));
    queue.add(sessionKey('pending'));
    queue.addAfter(sessionKey('delayed'), 5_000);

    const done = queue.shutdown();
    gate.resolve();
    await done;

    expect(runs).toEqual(['slow']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(['slow']); // pending dropped, delayed timer cleared
    queue.add(sessionKey('late'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runs).toEqual(['slow']); // adds after shutdown are inert
  });

  it('routes singleton keys to their handlers', async () => {
    const calls: string[] = [];
    const queue = createReconcileQueue({
      reconcile: async () => {
        calls.push('session');
      },
      singletons: {
        'singleton:egress-reheal': async () => {
          calls.push('egress');
        },
        'singleton:approvals-scan': async () => {
          calls.push('approvals');
        },
      },
    });

    queue.add('singleton:egress-reheal');
    queue.add(sessionKey('s-1'));
    queue.add('singleton:approvals-scan');
    await queue.idle();
    expect(calls).toEqual(['egress', 'session', 'approvals']);
  });
});
