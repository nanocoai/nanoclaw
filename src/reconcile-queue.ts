/**
 * In-process keyed workqueue for per-session reconciliation — the runtime
 * behind the `ReconcileQueue` contract in src/reconcile.ts.
 *
 * Semantics (the contract, made concrete):
 * - Level-triggered coalescing: an add for a key already waiting is a no-op;
 *   an add for a key currently running marks it dirty so it runs once more
 *   after — a change racing an in-flight reconcile is never lost until the
 *   resync floor.
 * - `addAfter` keeps the earliest due time per key and is superseded by a
 *   plain `add`.
 * - A thrown reconcile backs off per key (5s doubling, capped) without ever
 *   holding up other keys. The cap stays under the sweep's resync interval —
 *   past that point the resync re-add would fire first anyway.
 * - Execution is serial by default (`concurrency: 1`) — the same profile as
 *   the sweep loop this queue replaces. The knob exists so raising it later
 *   is a config change, not a rewrite.
 *
 * `idle()` (beyond the contract) resolves when nothing is running and nothing
 * is immediately ready; delayed retries don't count. The sweep uses it to end
 * a tick only after the tick's work is done.
 */
import { log } from './log.js';
import {
  sessionIdOf,
  type ReconcileFn,
  type ReconcileKey,
  type ReconcileQueue,
  type SingletonKey,
} from './reconcile.js';

const INITIAL_BACKOFF_MS = 5_000;
// Bounded under the 60s resync floor: a longer backoff would always be beaten
// by the next tick's re-add, so it would only misreport the retry cadence.
const MAX_BACKOFF_MS = 30_000;

export interface ReconcileQueueOptions {
  reconcile: ReconcileFn;
  singletons: Record<SingletonKey, () => Promise<void>>;
  /** Parallel reconciles. Default 1 — the serial profile of the sweep loop. */
  concurrency?: number;
}

interface Delayed {
  timer: NodeJS.Timeout;
  dueAt: number;
}

class InProcessReconcileQueue implements ReconcileQueue {
  private readonly reconcile: ReconcileFn;
  private readonly singletons: Record<SingletonKey, () => Promise<void>>;
  private readonly concurrency: number;

  private readonly ready: ReconcileKey[] = [];
  private readonly readySet = new Set<ReconcileKey>();
  private readonly runningKeys = new Set<ReconcileKey>();
  private readonly dirty = new Set<ReconcileKey>();
  private readonly delayed = new Map<ReconcileKey, Delayed>();
  private readonly failures = new Map<ReconcileKey, number>();
  private active = 0;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(options: ReconcileQueueOptions) {
    this.reconcile = options.reconcile;
    this.singletons = options.singletons;
    this.concurrency = options.concurrency ?? 1;
  }

  add(key: ReconcileKey): void {
    if (this.stopped) return;
    if (this.readySet.has(key)) return;
    if (this.runningKeys.has(key)) {
      this.dirty.add(key);
      return;
    }
    // Running now supersedes a scheduled retry.
    const pending = this.delayed.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.delayed.delete(key);
    }
    this.readySet.add(key);
    this.ready.push(key);
    this.pump();
  }

  addAfter(key: ReconcileKey, delayMs: number): void {
    if (this.stopped) return;
    if (this.readySet.has(key)) return; // already due sooner
    const dueAt = Date.now() + delayMs;
    const existing = this.delayed.get(key);
    if (existing) {
      if (existing.dueAt <= dueAt) return; // earliest due time wins
      clearTimeout(existing.timer);
    }
    const timer = setTimeout(() => {
      this.delayed.delete(key);
      this.add(key);
    }, delayMs);
    this.delayed.set(key, { timer, dueAt });
  }

  /** Resolves when nothing is running or immediately ready. Delayed retries don't count. */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const pending of this.delayed.values()) clearTimeout(pending.timer);
    this.delayed.clear();
    this.ready.length = 0;
    this.readySet.clear();
    this.dirty.clear();
    await this.idle();
  }

  private isIdle(): boolean {
    return this.active === 0 && this.ready.length === 0;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.ready.length > 0) {
      const key = this.ready.shift() as ReconcileKey;
      this.readySet.delete(key);
      this.active++;
      this.runningKeys.add(key);
      void this.run(key);
    }
  }

  private async run(key: ReconcileKey): Promise<void> {
    let retryInMs = 0;
    try {
      await this.dispatch(key);
      this.failures.delete(key);
    } catch (err) {
      const attempt = (this.failures.get(key) ?? 0) + 1;
      this.failures.set(key, attempt);
      retryInMs = Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      log.error('Reconcile failed — retrying with backoff', { key, attempt, retryInMs, err });
    } finally {
      this.runningKeys.delete(key);
      this.active--;
      // A dirty re-add signals fresh state — run again now, superseding backoff.
      if (this.dirty.delete(key)) this.add(key);
      else if (retryInMs > 0) this.addAfter(key, retryInMs);
      this.pump();
      if (this.isIdle()) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  private dispatch(key: ReconcileKey): Promise<void> {
    const sessionId = sessionIdOf(key);
    if (sessionId !== null) return this.reconcile(sessionId);
    const handler = this.singletons[key as SingletonKey];
    if (!handler) return Promise.reject(new Error(`no handler registered for queue key '${key}'`));
    return handler();
  }
}

export function createReconcileQueue(options: ReconcileQueueOptions): InProcessReconcileQueue {
  return new InProcessReconcileQueue(options);
}

export type { InProcessReconcileQueue };
