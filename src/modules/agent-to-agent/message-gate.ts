/**
 * Approve handler for a held a2a message, plus the source-chat feedback for
 * both outcomes. The generic approvals layer writes the agent's own note on
 * reject and on a failed apply; this file adds the same news to the source
 * session's attached chat.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { GuardDenyError } from '../../guard/index.js';
import { log } from '../../log.js';
import type { ApprovalHandler, ApprovalResolvedHandler } from '../approvals/index.js';
import { getUserRoles } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';
import { A2A_MESSAGE_GATE_ACTION, routeAgentMessage, type RoutableAgentMessage } from './agent-route.js';
import { notifySource } from './notify-source.js';

export const applyA2aMessageGate: ApprovalHandler = async ({ session, payload, approval, notify }) => {
  const { id, platform_id, content, in_reply_to } = payload;
  if (typeof platform_id !== 'string' || !platform_id) {
    const text = 'Message approved but the target agent group was missing from the request.';
    await notify(text);
    await notifySource(session.id, text, { agent: false });
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
      const text = `Message approved, but not delivered — no longer authorized: ${err.message}`;
      await notify(text);
      await notifySource(session.id, text, { agent: false });
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

async function approverLabel(userId: string): Promise<string> {
  const displayName = (await getUser(userId))?.display_name?.trim();
  if (displayName) return displayName;
  const roles = await getUserRoles(userId);
  return roles.some((role) => role.role === 'owner') ? 'An owner' : 'An admin';
}

/** Relay an a2a rejection to the source chat. finalizeReject already told the agent. */
export const onA2aApprovalResolved: ApprovalResolvedHandler = async ({
  approval,
  session,
  outcome,
  userId,
  reason,
}) => {
  if (approval.action !== A2A_MESSAGE_GATE_ACTION || outcome !== 'reject') return;
  const payload = JSON.parse(approval.payload) as Record<string, unknown>;
  const targetId = typeof payload.platform_id === 'string' ? payload.platform_id : null;
  const sourceName = (await getAgentGroup(session.agent_group_id))?.name ?? session.agent_group_id;
  const targetName = (targetId && (await getAgentGroup(targetId))?.name) || targetId || 'the target agent';
  const text = `${await approverLabel(userId)} rejected ${sourceName}'s message to ${targetName}.${reason !== undefined ? ` Reason: ${reason}` : ''}`;
  await notifySource(session.id, text, { agent: false });
};
