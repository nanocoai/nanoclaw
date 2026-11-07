/**
 * Due-time wake feed — reconcile a session the moment its next scheduled
 * message becomes due, instead of on the next resync tick.
 *
 * The sweep reconciles every session about once a minute, so a task due at
 * :00 could start up to a minute late. Each reconcile reports the session's
 * next due time here; when it falls inside the horizon, one timer per session
 * asks for a reconcile just after that instant. Like the other feeds this is
 * additive: the reconcile re-reads truth (cap, wake and claim rules all
 * unchanged), a stale or lost timer costs one no-op reconcile or one tick of
 * latency, and an unregistered feed makes the enqueue a no-op.
 */
import { enqueueSessionReconcile } from './reconcile-feeds.js';

/**
 * Only arm due times this close. Further ones are re-reported by a later
 * reconcile (the resync visits every session each tick), which also keeps
 * every delay far below setTimeout's 2^31 ms ceiling.
 */
export const DUE_WAKE_HORIZON_MS = 5 * 60_000;

/** Fire just after the due instant, so the row already counts as due when the reconcile reads it. */
const FIRE_LAG_MS = 250;

const armed = new Map<string, { at: number; timer: NodeJS.Timeout }>();

/** Arm (or move) the session's timer to its next due time; null or out of horizon disarms nothing. */
export function scheduleDueWake(sessionId: string, dueAt: string | null, now: number = Date.now()): void {
  if (dueAt === null) return;
  const at = Date.parse(dueAt);
  if (!Number.isFinite(at) || at <= now || at - now > DUE_WAKE_HORIZON_MS) return;
  const current = armed.get(sessionId);
  if (current?.at === at) return;
  if (current) clearTimeout(current.timer);
  const timer = setTimeout(
    () => {
      armed.delete(sessionId);
      enqueueSessionReconcile(sessionId);
    },
    at - now + FIRE_LAG_MS,
  );
  timer.unref();
  armed.set(sessionId, { at, timer });
}

/** Drop every pending timer (sweep shutdown). */
export function clearDueWakes(): void {
  for (const { timer } of armed.values()) clearTimeout(timer);
  armed.clear();
}

/** Test-only view of the armed due time for one session. */
export function _armedDueWakeForTesting(sessionId: string): number | undefined {
  return armed.get(sessionId)?.at;
}
