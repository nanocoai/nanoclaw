/**
 * Host sweep — the periodic resync over all session mailboxes.
 *
 * The per-session body lives in src/reconcile-session.ts (`reconcileSession`,
 * the ReconcileFn shape from src/reconcile.ts); execution runs through the
 * keyed workqueue (src/reconcile-queue.ts), RECONCILE_CONCURRENCY sessions
 * at a time. This module owns the resync floor: every 60s it enqueues the
 * singleton duties and every active session, then re-arms once the tick's
 * work has drained — so queue loss costs latency, never correctness, and an
 * explicit enqueue between ticks can never be lost to a concurrent sweep.
 * The re-exports below keep the long-standing import surface of this module
 * stable.
 */
import { INSTALL_SLUG } from './config.js';
import { retryPendingAdoptions, stopOrphanedSessions } from './container-runner.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { getActiveSessions } from './db/sessions.js';
import { peekSessionDriver } from './drivers/index.js';
import type { SessionWatch } from './drivers/types.js';
import { log } from './log.js';
import { registerReconcileEnqueue } from './reconcile-feeds.js';
import { createReconcileQueue, type InProcessReconcileQueue } from './reconcile-queue.js';
import { reconcileSession } from './reconcile-session.js';
import { sessionKey } from './reconcile.js';

export {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
  shouldCloseTaskSession,
  type StuckDecision,
} from './reconcile-session.js';

const SWEEP_INTERVAL_MS = 60_000;

/**
 * Sessions reconciled in parallel. Each reconcile is one session's mailbox
 * round trip plus a few central reads; on a remote mailbox that is network
 * latency, and serially it made a tick scale as sessions × latency (300
 * sessions × 40 ms/hop ≈ 25 s per tick). Keys never overlap with themselves
 * (the queue serializes per key), sessions are independent by the mailbox
 * contract, and the two singleton duties tolerate running alongside sessions
 * (spawn re-heals the egress network itself; the approvals scan is a central
 * query). 8 is a modest fan-out for a remote store; local SQLite is
 * synchronous IO and neither gains nor loses.
 */
export const RECONCILE_CONCURRENCY = 8;

interface SweepGeneration {
  queue: InProcessReconcileQueue;
  watch: SessionWatch | null;
  timer: { handle?: NodeJS.Timeout } | null;
  tick: Promise<void>;
}

let current: SweepGeneration | null = null;
const draining = new Set<Promise<void>>();

/** Coalesced enqueue for the event feeds; drops harmlessly once stopped. */
function feedEnqueue(sessionId: string): void {
  current?.queue.add(sessionKey(sessionId));
}

/**
 * Reconcile promptly when the runtime reports a session ended: due mail on a
 * dead session waits one queue turn instead of the next resync tick. Arms
 * only against a driver that already exists — the sweep never instantiates
 * one, so suites (and hosts) that never selected a runtime are untouched.
 * Events are hints (they may drop, duplicate, or reference foreign keys);
 * the enqueue re-reads truth, so all of that is safe by construction.
 */
function armRuntimeWatch(generation: SweepGeneration): void {
  const driver = peekSessionDriver();
  // Raw test fakes may lack watchSessions; never crash on them.
  if (!driver || typeof driver.watchSessions !== 'function') return;
  /* eslint-disable no-catch-all/no-catch-all -- a watch backend that cannot subscribe costs latency (the resync floor covers it), never the boot */
  try {
    generation.watch = driver.watchSessions(INSTALL_SLUG, (event) => {
      if (current !== generation) return;
      if (event.kind !== 'terminal' || !event.key.sessionId) return;
      feedEnqueue(event.key.sessionId);
    });
  } catch (err) {
    log.warn('Runtime watch feed unavailable — the resync floor covers it', { err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export function startHostSweep(): void {
  if (current) return;
  const queue = createReconcileQueue({
    reconcile: reconcileSession,
    concurrency: RECONCILE_CONCURRENCY,
    singletons: {
      // Re-heal the egress network so already-running agents keep their
      // gateway hop if it was detached out-of-band. Best-effort: a heal
      // failure isn't a leak (agents stay on the internal net), so log and
      // continue — never surface a throw into queue backoff. No-op when
      // lockdown is disabled.
      'singleton:egress-reheal': async () => {
        try {
          ensureEgressNetwork();
        } catch (err) {
          log.error('Egress lockdown re-heal failed', { err });
        }
      },
      // Stop containers whose session or agent group was deleted: the
      // per-session reconcile only visits sessions that still have a row.
      // Then retry adoptions a failed claim write deferred (never throws).
      'singleton:orphan-containers': async () => {
        try {
          await stopOrphanedSessions();
        } catch (err) {
          log.error('Orphaned container sweep failed', { err });
        }
        await retryPendingAdoptions();
      },
      // Finalize any "Reject with reason…" holds whose reply window elapsed
      // (admin ghosted, or the host restarted mid-capture). Central-DB scan,
      // once per tick — not per session.
      // MODULE-HOOK:approvals-reason-sweep:start
      'singleton:approvals-scan': async () => {
        try {
          const { sweepAwaitingReasonRejects } = await import('./modules/approvals/index.js');
          await sweepAwaitingReasonRejects();
        } catch (err) {
          log.error('Reject-with-reason sweep failed', { err });
        }
      },
      // MODULE-HOOK:approvals-reason-sweep:end
    },
  });
  // Event feeds — additive over the resync floor: mail writes and runtime
  // terminal events land as coalesced enqueues, so behavior only gets
  // faster, never different, and a lost event costs at most one tick.
  const generation: SweepGeneration = { queue, watch: null, timer: null, tick: Promise.resolve() };
  current = generation;
  registerReconcileEnqueue(feedEnqueue);
  armRuntimeWatch(generation);
  generation.tick = sweep(generation);
}

/**
 * Stop admission immediately, then drain every generation already stopping.
 * Callers must await this before closing the DB or releasing sweep resources.
 * A subsequent start is independent and is not included in this stop's drain.
 */
export async function stopHostSweep(): Promise<void> {
  const generation = current;
  current = null;
  registerReconcileEnqueue(null);
  if (generation) {
    if (generation.timer?.handle !== undefined) clearTimeout(generation.timer.handle);
    generation.timer = null;
    if (generation.watch) {
      /* eslint-disable no-catch-all/no-catch-all -- a watch backend that is already gone must not block shutdown */
      try {
        generation.watch.stop();
      } catch (err) {
        log.warn('Runtime watch feed stop failed', { err });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
    // Shutdown drops pending adds, but the tick may also be awaiting the
    // session listing outside the queue. Both must finish before DB teardown.
    const drain = Promise.allSettled([generation.queue.shutdown(), generation.tick]).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
    draining.add(drain);
    // Keep the tracked promise rejection handled even if a caller forgets to
    // await; the returned stop promise still reports the drain failure.
    void drain.then(
      () => draining.delete(drain),
      () => draining.delete(drain),
    );
  }
  const results = await Promise.allSettled([...draining]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

async function sweep(generation: SweepGeneration): Promise<void> {
  if (current !== generation) return;
  const tickQueue = generation.queue;

  // Enqueue order matches the loop this replaces: egress re-heal, then every
  // active session, then the approvals scan; the orphan-container stop last. Keys START in that order; up to
  // RECONCILE_CONCURRENCY of them run at once.
  tickQueue.add('singleton:egress-reheal');
  try {
    const sessions = await getActiveSessions();
    if (current !== generation) return;
    for (const session of sessions) {
      tickQueue.add(sessionKey(session.id));
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }
  if (current !== generation) return;
  tickQueue.add('singleton:approvals-scan');
  tickQueue.add('singleton:orphan-containers');

  // The tick ends — and the next one is armed — only after everything this
  // tick enqueued has run. Delayed backoff retries don't hold the tick open.
  await tickQueue.idle();
  if (current !== generation) return;
  const timer: NonNullable<SweepGeneration['timer']> = {};
  generation.timer = timer;
  timer.handle = setTimeout(() => {
    if (current !== generation || generation.timer !== timer) return;
    generation.timer = null;
    generation.tick = sweep(generation);
  }, SWEEP_INTERVAL_MS);
}
