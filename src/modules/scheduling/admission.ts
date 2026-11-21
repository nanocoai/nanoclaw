/**
 * Scheduler admission — the decision of whether a session with due messages
 * may be woken now, and a notification when a running session has gone idle.
 *
 * The default admits every wake and ignores idleness, which is exactly the
 * sweep's behavior without this seam. An install that wants a concurrency cap,
 * task priorities, or quiet hours registers its own admission once at startup;
 * a deferred wake is simply retried on the next reconcile because the due rows
 * are still there.
 */
import type { TaskRecord } from '../../mailbox/index.js';
import type { Session } from '../../types.js';

export interface DueSessionCandidate {
  session: Session;
  /** Due trigger messages in the inbound mailbox (always > 0). */
  dueCount: number;
  /** True for a scheduled-task session thread. */
  isTaskSession: boolean;
  /**
   * Pending tasks whose run time has arrived. `content` is the raw task
   * envelope, so a policy can read fields it stored there itself.
   */
  dueTasks: TaskRecord[];
}

export interface SchedulerAdmission {
  /** Resolve false to defer the wake; the next reconcile asks again. */
  shouldWake(candidate: DueSessionCandidate): Promise<boolean>;
  /** A running container has no due messages and no message in flight. */
  onSessionIdle?(session: Session): Promise<void>;
}

const admitAll: SchedulerAdmission = { shouldWake: async () => true };

let active: SchedulerAdmission = admitAll;

/** Replace the admission policy. Last registration wins; null restores the default. */
export function registerSchedulerAdmission(admission: SchedulerAdmission | null): void {
  active = admission ?? admitAll;
}

export function schedulerAdmission(): SchedulerAdmission {
  return active;
}

export function hasCustomSchedulerAdmission(): boolean {
  return active !== admitAll;
}
