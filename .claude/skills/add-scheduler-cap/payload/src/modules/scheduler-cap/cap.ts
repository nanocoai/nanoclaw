/**
 * Concurrency cap for scheduler-driven wakes.
 *
 * A wake is admitted while the number of running containers, plus wakes this
 * policy admitted that have not spawned yet, is below the limit. Deferred
 * sessions are retried by the next reconcile because their due rows remain.
 * When the cap is full and a session is waiting, a running container that has
 * gone idle is stopped so the waiting session can take its place.
 */
import type { DueSessionCandidate, SchedulerAdmission } from '../scheduling/admission.js';
import type { Session } from '../../types.js';

export interface SchedulerCapDeps {
  /** Maximum number of containers running at once. Must be a positive integer. */
  limit: number;
  /** Containers running right now. */
  activeCount(): number;
  isRunning(sessionId: string): boolean;
  stop(sessionId: string, reason: string): void;
  now(): number;
}

/** How long an admitted wake may take to appear as a running container. */
export const RESERVATION_TTL_MS = 60_000;
/** How long a deferred session counts as waiting without being asked again. */
export const WAITING_TTL_MS = 180_000;

export function createSchedulerCap(deps: SchedulerCapDeps): SchedulerAdmission {
  const reserved = new Map<string, number>();
  const waiting = new Map<string, number>();

  function prune(): void {
    const now = deps.now();
    for (const [id, expires] of reserved) {
      // A running container is already part of activeCount().
      if (expires <= now || deps.isRunning(id)) reserved.delete(id);
    }
    for (const [id, expires] of waiting) {
      if (expires <= now) waiting.delete(id);
    }
  }

  function occupied(): number {
    return deps.activeCount() + reserved.size;
  }

  return {
    async shouldWake(candidate: DueSessionCandidate): Promise<boolean> {
      prune();
      const id = candidate.session.id;
      if (reserved.has(id) || occupied() < deps.limit) {
        reserved.set(id, deps.now() + RESERVATION_TTL_MS);
        waiting.delete(id);
        return true;
      }
      waiting.set(id, deps.now() + WAITING_TTL_MS);
      return false;
    },

    async onSessionIdle(session: Session): Promise<void> {
      prune();
      waiting.delete(session.id);
      if (waiting.size === 0 || occupied() < deps.limit) return;
      deps.stop(session.id, 'scheduler-cap-idle');
    },
  };
}
