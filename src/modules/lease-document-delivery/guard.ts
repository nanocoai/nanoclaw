/**
 * Lease document-delivery guard adapter — the module's catalog entry,
 * composed at the module edge (imported by ./index.ts).
 *
 * Unlike lease-manager-generate (always HOLD, needs a human card every
 * time), this decides WHO may call the action, directly: only Pepper's own
 * agent group, identity checked right here rather than deferred to a
 * precheck, since there is no approval card to build either way. Generation
 * already went through admin approval; sending Kirk a copy of his own
 * already-approved draft doesn't need a second approval gate. Everything
 * else -- is the reference real, is the file actually a verified PDF inside
 * Drafts -- is a domain check, not an identity decision, so it lives in
 * ./resolve.ts instead.
 *
 * Ported verbatim from old commit 59de60dc -- confirmed the guard seam
 * (defineGuardedAction/ALLOW/DENY/GuardInput) is structurally unchanged
 * from current upstream.
 */
import { ALLOW, DENY, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import { PEPPER_AGENT_GROUP_ID } from './config.js';

function decide(input: GuardInput) {
  if (input.actor.kind !== 'agent') {
    return DENY('lease_document_deliver is a container-originated action.');
  }
  if (input.actor.agentGroupId !== PEPPER_AGENT_GROUP_ID) {
    return DENY('lease_document_deliver is only usable by Pepper -- the human-facing delivery agent.');
  }
  return ALLOW('Pepper delivering a copy of an already-approved, already-generated document to Kirk himself.');
}

// No grantActionName: decide() above only ever returns allow/deny, never
// hold, so there is no pending_approvals action for a grant to match.
export const leaseDocumentDeliver = defineGuardedAction({
  action: 'lease_document_deliver.submit',
  decide,
});
