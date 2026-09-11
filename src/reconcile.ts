/**
 * Reconciler contract (types only — no runtime yet).
 *
 * The 60s host sweep becomes per-key reconciliation: `sweepSession`'s
 * responsibilities (ack sync, due-message wake, mailbox maintenance / stale
 * detection / recurrence — host-sweep.ts stays the source of truth for the
 * ported logic) move into `reconcileSession(sessionId)` driven by a keyed
 * workqueue. Per-session reconcile with event-driven requeue beats the
 * global tick — faster wakes, no full sweep on every beat — and a host
 * restart becomes a resync instead of an adoption ceremony. This module
 * freezes the surface so the queue implementation, the sweep port, and the
 * wake path can land independently.
 *
 * Queue semantics the implementation must honor:
 * - Coalescing: adding a key already queued is a no-op (level-triggered — the
 *   reconcile reads current state, so one run covers many adds).
 * - `addAfter` schedules a retry/backoff without blocking the queue.
 * - Per-key backoff on reconcile failure; other keys are never held up.
 * - A periodic full resync (the 60s ticker) re-adds every active session key
 *   as the loss floor: queue loss costs latency, never correctness.
 */

/** Reconcile one session against desired state. Idempotent; reads current state. */
export type ReconcileFn = (sessionId: string) => Promise<void>;

/**
 * Singleton work that today rides the global sweep tick rather than any one
 * session. Each becomes its own coalesced queue key.
 */
export const SINGLETON_KEYS = ['singleton:egress-reheal', 'singleton:approvals-scan'] as const;
export type SingletonKey = (typeof SINGLETON_KEYS)[number];

export type ReconcileKey = `session:${string}` | SingletonKey;

export function sessionKey(sessionId: string): ReconcileKey {
  return `session:${sessionId}`;
}

/** Extract the session id from a session key; null for singleton keys. */
export function sessionIdOf(key: ReconcileKey): string | null {
  return key.startsWith('session:') ? key.slice('session:'.length) : null;
}

export interface ReconcileQueue {
  /** Enqueue now. Coalesces with an already-pending add of the same key. */
  add(key: ReconcileKey): void;
  /** Enqueue after a delay (retry/backoff). Coalesces to the earliest due time. */
  addAfter(key: ReconcileKey, delayMs: number): void;
  /** Stop the queue; in-flight reconciles finish, pending adds are dropped. */
  shutdown(): Promise<void>;
}
