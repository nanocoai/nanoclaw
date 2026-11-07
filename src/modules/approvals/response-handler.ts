/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on plain reject we relay a decline to the agent; on
 *      "Reject with reason…" we hold the row and capture the admin's next DM as
 *      a one-line reason (see reason-capture.ts). Reject finalization is shared
 *      via finalizeReject.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import {
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByShortId,
  getSession,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { finalizeReject } from './finalize.js';
import { getApprovalHandler, notifyApprovalResolved, REJECT_WITH_REASON_VALUE } from './primitive.js';
import { armReasonCapture, clampReason, extractText } from './reason-capture.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  const approval = await getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (!(await isAuthorizedApprovalClick(approval, payload))) {
    log.warn('Ignoring unauthorized approval response', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
    });
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, namespacedUserId(payload) ?? '');
  return true;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
  reason?: string,
): Promise<void> {
  if (!approval.session_id) {
    await deletePendingApproval(approval.approval_id);
    return;
  }
  const session = await getSession(approval.session_id);
  if (!session) {
    await deletePendingApproval(approval.approval_id);
    return;
  }

  // "Reject with reason…" — hold the row and capture the admin's next DM
  // instead of finalizing now. The agent is notified exactly once: after the
  // reason arrives, or after the sweep's timeout if the admin ghosts.
  if (selectedOption === REJECT_WITH_REASON_VALUE) {
    await armReasonCapture(approval, session, userId);
    return;
  }

  // Plain Reject (or any other non-approve value) — instant fast path.
  if (selectedOption !== 'approve') {
    await finalizeReject(approval, session, userId, reason);
    return;
  }

  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'approved'))) return;

  // Approved — dispatch to the module that registered for this action.
  const notify = (text: string): Promise<void> =>
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    });

  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    await notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    await deletePendingApproval(approval.approval_id);
    await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
    await requestWake(session, 'approval-response');
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, approval, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    await notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  await deletePendingApproval(approval.approval_id);
  await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
  await requestWake(session, 'approval-response');
}

const TEXT_REPLY = /^(approve|reject)\s+([a-z0-9]{6})(?:\s+(\S[\s\S]*))?$/i;

/**
 * Typed answer to an approval card on a channel that rendered it as text
 * (see sendApprovalCard's fallbackText). Only the card's own chat can name it,
 * and the sender is checked exactly like a button click.
 */
export async function handleApprovalTextReply(event: InboundEvent): Promise<boolean> {
  const match = TEXT_REPLY.exec(extractText(event).trim());
  if (!match) return false;
  const [, verb, shortId, reason] = match;
  const option = verb.toLowerCase();
  if (option === 'approve' && reason) return false;

  const instance = event.instance ?? event.channelType;
  const reply = (text: string) =>
    getDeliveryAdapter()?.deliver(
      event.channelType,
      event.platformId,
      event.threadId,
      'chat-sdk',
      JSON.stringify({ text }),
      undefined,
      instance,
    );
  const approvals = (
    await getPendingApprovalsByShortId(shortId.toLowerCase(), event.channelType, event.platformId)
  ).filter((a) => (a.instance ?? a.channel_type) === instance);
  if (approvals.length !== 1) {
    await reply(`No pending approval ${shortId}.`);
    return true;
  }

  const [approval] = approvals;
  const { senderId } = JSON.parse(event.message.content) as { senderId?: unknown };
  const payload: ResponsePayload = {
    questionId: approval.approval_id,
    value: option,
    userId: typeof senderId === 'string' ? senderId : null,
    channelType: event.channelType,
    instance,
    platformId: event.platformId,
    threadId: event.threadId,
  };
  if (!(await isAuthorizedApprovalClick(approval, payload))) {
    log.warn('Ignoring approval reply from a non-approver', {
      approvalId: approval.approval_id,
      userId: payload.userId,
    });
    return true;
  }
  await handleRegisteredApproval(approval, option, namespacedUserId(payload) ?? '', reason && clampReason(reason));
  await reply(option === 'approve' ? '✅ Approved' : '❌ Rejected');
  return true;
}

registerMessageInterceptor(handleApprovalTextReply);

export function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

export async function isAuthorizedApprovalClick(approval: PendingApproval, payload: ResponsePayload): Promise<boolean> {
  const userId = namespacedUserId(payload);
  if (!userId) return false;

  // An approval may name a specific approver; only that exact user may resolve it.
  if (approval.approver_user_id) {
    return userId === approval.approver_user_id;
  }

  const agentGroupId =
    approval.agent_group_id ?? (approval.session_id ? (await getSession(approval.session_id))?.agent_group_id : null);

  if (!agentGroupId) {
    return (await isOwner(userId)) || (await isGlobalAdmin(userId));
  }

  return hasAdminPrivilege(userId, agentGroupId);
}
