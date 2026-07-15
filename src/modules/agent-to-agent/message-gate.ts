/** Approve handler for a held a2a message. (Reject is handled by the generic response-handler path.) */
import { GuardDenyError } from '../../guard/index.js';
import { log } from '../../log.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { routeAgentMessage, type RoutableAgentMessage } from './agent-route.js';

export const applyA2aMessageGate: ApprovalHandler = async ({ session, payload, approval, notify }) => {
  const { id, platform_id, content, in_reply_to } = payload;
  if (typeof platform_id !== 'string' || !platform_id) {
    notify('Message approved but the target agent group was missing from the request.');
    log.warn('a2a_message_gate apply: missing target', { sessionId: session.id });
    return;
  }

  const msg: RoutableAgentMessage = {
    id: typeof id === 'string' ? id : `a2a-gate-${Date.now()}`,
    platform_id,
    content: typeof content === 'string' ? content : '',
    in_reply_to: typeof in_reply_to === 'string' ? in_reply_to : null,
  };

  // One replay semantics: re-enter the guarded route carrying the approval
  // row as the grant. The policy hold is satisfied, but the structural
  // checks run live — a deny here (destination revoked while the card was
  // pending, dead or mismatched grant) is an EXPECTED policy outcome, not a
  // crash: tell the requester, log a warning, and let anything else keep the
  // response handler's failure path.
  try {
    await routeAgentMessage(msg, session, { grant: approval });
  } catch (err) {
    if (err instanceof GuardDenyError) {
      log.warn('Approved a2a replay refused by the guard', {
        from: session.agent_group_id,
        to: platform_id,
        msgId: msg.id,
        reason: err.message,
      });
      notify(`Message approved, but not delivered — no longer authorized: ${err.message}`);
      return;
    }
    throw err;
  }
  log.info('Held agent message delivered after approval', {
    from: session.agent_group_id,
    to: platform_id,
    msgId: msg.id,
  });
};
