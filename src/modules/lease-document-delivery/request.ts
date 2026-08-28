/**
 * Precheck for lease_document_deliver — runs before the guard consult (see
 * runGuarded in ../../delivery-guard.ts), so it re-checks the calling agent
 * group itself rather than relying on guard.ts having already run: a
 * precheck failure for the wrong caller means they never learn whether a
 * document_reference they supplied resolved to anything real.
 *
 * `requestLeaseDocumentDeliverHold` exists only because DeliveryGuardSpec
 * requires one — guard.ts's decide() never returns hold for this action, so
 * this should be unreachable. If it ever fires, that's a guard regression,
 * not a normal flow, so it fails loudly rather than silently creating a
 * card nobody asked for.
 *
 * Ported from old commit 59de60dc, adapted to await notifyAgent (now
 * async) and resolveAndValidateDocument (now async).
 * validateLeaseDocumentDeliver's signature changes boolean ->
 * Promise<boolean>, the same shape every other precheck in this
 * reconciliation uses.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import { PEPPER_AGENT_GROUP_ID } from './config.js';
import { resolveAndValidateDocument } from './resolve.js';

export async function validateLeaseDocumentDeliver(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== PEPPER_AGENT_GROUP_ID) {
    await notifyAgent(session, 'lease_document_deliver failed: not permitted for this agent.');
    log.warn('lease_document_deliver: rejected non-Pepper caller', { agentGroupId: session.agent_group_id });
    return false;
  }

  const result = await resolveAndValidateDocument(content.document_reference);
  if (!result.ok) {
    await notifyAgent(session, `lease_document_deliver failed: ${result.reason}`);
    log.warn('lease_document_deliver: precheck rejected', { reason: result.reason });
    return false;
  }

  return true;
}

export async function requestLeaseDocumentDeliverHold(
  _content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  log.error('lease_document_deliver: requestHold invoked -- this action should never hold; guard.ts regressed');
  await notifyAgent(session, 'lease_document_deliver failed: unexpected approval hold. This has been logged as a bug.');
}
