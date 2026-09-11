/**
 * Reconcile enqueue feed — the narrow bridge between "something changed for
 * this session" and the sweep's workqueue, with no import edge back into the
 * sweep. Producers (the inbound mail writer, the runtime watch feed) call
 * `enqueueSessionReconcile`; the sweep registers the real enqueue while it
 * runs and clears it on stop, so producers are always safe to call — an
 * unregistered feed is a no-op and the periodic resync still covers the
 * change. Extra enqueues are free: the queue coalesces and the reconcile body
 * is level-triggered, so a spurious call costs one no-op re-read, never a
 * behavior change.
 */
import { log } from './log.js';

let enqueue: ((sessionId: string) => void) | null = null;

/** The sweep's hook. Last registration wins; null clears. */
export function registerReconcileEnqueue(fn: ((sessionId: string) => void) | null): void {
  enqueue = fn;
}

/**
 * Ask for a prompt reconcile of one session. Fire-and-forget and never
 * throws — a feed must never break the write path that called it.
 */
export function enqueueSessionReconcile(sessionId: string): void {
  if (!enqueue) return;
  /* eslint-disable no-catch-all/no-catch-all -- a failed enqueue costs latency (the resync floor covers it), never the caller's write */
  try {
    enqueue(sessionId);
  } catch (err) {
    log.warn('Reconcile enqueue failed', { sessionId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
