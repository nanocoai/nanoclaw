/**
 * Auth-respawn module.
 *
 * When the container detects an OAuth credential error (stale token after a
 * refresh), it resets its processing_ack entries, writes a `credential_error`
 * system action, and exits. This handler receives that action and respawns a
 * fresh container — which reads the current credentials file and gets the
 * updated token.
 */
import { log } from '../log.js';
import { registerDeliveryAction } from '../delivery.js';
import { unguarded } from '../guard/index.js';
import { wakeContainer } from '../container-runner.js';

registerDeliveryAction(
  'credential_error',
  async (_content, session) => {
    log.warn('Container reported credential error — will respawn with fresh token', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });

    // The container calls process.exit() after writing this action, but the
    // host may process the action before the container fully exits and is
    // removed from activeContainers. A short delay lets the exit propagate
    // so wakeContainer sees it as not running and spawns a replacement.
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
    }, 2000);
  },
  unguarded("internal signal from the container's own auth-check — no user/agent input involved"),
);
