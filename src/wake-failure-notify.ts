/**
 * Wake-failure notifier (#2902).
 *
 * A message can be accepted on a channel (the user sees it delivered) and
 * then never reach an agent: `wakeContainer` fails — OneCLI gateway down,
 * runtime misconfigured — and host-sweep retries silently every tick,
 * forever. The only trace was a WARN in logs/nanoclaw.error.log; from the
 * user's side the install was indistinguishable from "just not responding".
 *
 * This module turns a *persistent* wake failure into one rate-limited notice
 * on the originating channel. Design constraints:
 *
 * - Transient blips stay silent: nothing is sent before
 *   `NOTIFY_AFTER_FAILURES` consecutive failures for a session, so the
 *   normal fail→sweep-retry→succeed path never spams.
 * - A persistent outage notifies once per `RENOTIFY_INTERVAL_MS` per
 *   session, not once per retry.
 * - Best-effort by contract: the notifier itself can fail (the channel may
 *   be the broken part) — it must never throw into the wake path.
 * - No new state tables: the failure ledger is in-memory. A host restart
 *   resets it, which is correct — the restart is itself a fresh attempt.
 */
import { getMessagingGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import type { Session } from './types.js';

/** Consecutive failures before the first notice. */
export const NOTIFY_AFTER_FAILURES = 3;
/** Minimum gap between notices for the same session. */
export const RENOTIFY_INTERVAL_MS = 30 * 60 * 1000;

export const WAKE_FAILURE_NOTICE =
  '⚠️ Your message was received, but the assistant could not be started ' +
  '(the host keeps retrying). If this persists, the operator should check logs/nanoclaw.error.log.';

interface FailureEntry {
  consecutive: number;
  lastNotifiedAt: number | null;
}

const failures = new Map<string, FailureEntry>();

/** Record a failed wake. Returns true when a notice should go out now. */
export function recordWakeFailure(sessionId: string, now = Date.now()): boolean {
  const entry = failures.get(sessionId) ?? { consecutive: 0, lastNotifiedAt: null };
  entry.consecutive += 1;
  failures.set(sessionId, entry);
  if (entry.consecutive < NOTIFY_AFTER_FAILURES) return false;
  if (entry.lastNotifiedAt !== null && now - entry.lastNotifiedAt < RENOTIFY_INTERVAL_MS) return false;
  entry.lastNotifiedAt = now;
  return true;
}

/** A successful wake ends the failure streak (and re-arms the notifier). */
export function clearWakeFailures(sessionId: string): void {
  failures.delete(sessionId);
}

/** Test seam. */
export function _resetWakeFailuresForTesting(): void {
  failures.clear();
}

/**
 * Deliver the notice to the session's originating channel. Sessions without
 * a messaging group (task sessions, agent-to-agent) have no user waiting on
 * a channel — skip. Every failure mode degrades to a log line; the wake
 * path's never-throws contract extends through here.
 */
export async function notifyWakeFailure(session: Session): Promise<void> {
  try {
    if (!session.messaging_group_id) return;
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    const mg = await getMessagingGroup(session.messaging_group_id);
    if (!mg) return;
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id,
      'chat',
      JSON.stringify({ text: WAKE_FAILURE_NOTICE }),
      undefined,
      mg.instance ?? mg.channel_type,
    );
    log.info('Wake-failure notice delivered', { sessionId: session.id, messagingGroupId: mg.id });
  } catch (err) {
    // The channel may be part of the same outage — a failed notice is
    // expected there and must not disturb the retry loop.
    log.warn('Wake-failure notice could not be delivered', { sessionId: session.id, err });
  }
}
