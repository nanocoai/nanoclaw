/**
 * Lease Manager PDF-generation guard adapter — the module's catalog entry,
 * composed at the module edge (imported by ./index.ts).
 *
 * Decision is unconditional hold from the container path, same as
 * ../lease-manager-write/guard.ts: generating a lease PDF always needs
 * admin approval, since it produces a real file Kirk may hand to a tenant.
 * The "must be Lease Manager's own agent group" check, and all field
 * validation, are domain checks rather than guard decisions, so they live
 * in ./request.ts's precheck instead of here (same split as
 * lease-manager-write).
 *
 * Ported verbatim from old commit 59de60dc.
 */
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';

function decide(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('lease_manager_generate is a container-originated action.');
  }
  return HOLD('lease_manager_generate always requires admin approval from the container path');
}

export const leaseManagerGenerate = defineGuardedAction({
  action: 'lease_manager_generate.submit',
  grantActionName: 'lease_manager_generate',
  decide,
});
