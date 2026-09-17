/**
 * Bureaucracy-automation guard adapter — mirrors src/modules/self-mod/guard.ts's
 * shape exactly, minus the imageBuild capability gate (this action never
 * rebuilds anything — approval only unblocks an in-flight agent-browser
 * action already sitting behind its own `confirm`/`deny` gate).
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

function bureaucracySubmitDecide(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('bureaucracy_submit is a container-originated action.');
  }
  return HOLD('bureaucracy_submit always requires admin approval from the container path');
}

export const bureaucracySubmit = defineGuardedAction({
  action: 'bureaucracy_automation.submit',
  grantActionName: 'bureaucracy_submit',
  decide: bureaucracySubmitDecide,
});
