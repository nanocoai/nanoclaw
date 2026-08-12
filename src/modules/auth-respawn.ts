/**
 * Auth-respawn module.
 *
 * When the container detects an OAuth credential error (stale token after a
 * refresh), it resets its processing_ack entries, writes a `credential_error`
 * system action, and exits. This handler receives that action and respawns a
 * fresh container — which reads the current credentials file and gets the
 * updated token.
 *
 * A token that's slow to refresh (or a genuine outage) can turn this into a
 * tight respawn loop — one container exit per poll cycle — which churns
 * Docker networking (each spawn/teardown adds/drops a veth interface) badly
 * enough to disrupt host-side channel delivery on its own, independent of
 * the underlying auth problem. See the 2026-08-06/07 and 2026-08-11
 * incidents. Back off per session so a sustained loop settles to one
 * respawn attempt per BACKOFF_CAP_MS instead of hammering continuously.
 */
import { log } from '../log.js';
import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { wakeContainer } from '../container-runner.js';

const BASE_DELAY_MS = 2000;
const BACKOFF_CAP_MS = 30_000;
// If it's been this long since the session's last credential error, treat
// the next one as a fresh incident rather than a continuation of the old
// streak (the token likely refreshed and is now failing for a new reason).
const STREAK_RESET_MS = 5 * 60_000;

const respawnStreaks = new Map<string, { count: number; lastErrorAt: number }>();

registerDeliveryAction(
  'credential_error',
  async (_content, session) => {
    const now = Date.now();
    const prior = respawnStreaks.get(session.id);
    const count = prior && now - prior.lastErrorAt < STREAK_RESET_MS ? prior.count + 1 : 1;
    respawnStreaks.set(session.id, { count, lastErrorAt: now });

    const delayMs = Math.min(BASE_DELAY_MS * 2 ** (count - 1), BACKOFF_CAP_MS);

    log.warn('Container reported credential error — will respawn with fresh token', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      streakCount: count,
      delayMs,
    });

    // The container calls process.exit() after writing this action, but the
    // host may process the action before the container fully exits and is
    // removed from activeContainers. The delay (backed off across a streak
    // of consecutive errors for this session) lets the exit propagate so
    // wakeContainer sees it as not running and spawns a replacement.
    setTimeout(() => {
      void wakeContainer(session).then((ok) => {
        if (ok) {
          log.info('Container respawned after credential error', { sessionId: session.id });
        } else {
          log.warn('Respawn after credential error failed — host sweep will retry', {
            sessionId: session.id,
          });
        }
      });
    }, delayMs);
  },
  unguarded("internal signal from the container's own auth-check — no user/agent input involved"),
);
