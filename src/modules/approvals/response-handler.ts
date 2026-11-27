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
 * core offers a click to each handler in turn, and the first to return an
 * outcome owns it.
 */
import { requestWake } from '../../request-wake.js';
import {
  deletePendingApproval,
  getPendingApproval,
  getSession,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import type { ResponseOutcome, ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { namespacedUserId } from '../../platform-id.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { finalizeReject } from './finalize.js';
import { getApprovalHandler, notifyApprovalResolved, REJECT_WITH_REASON_VALUE } from './primitive.js';
import { armReasonCapture } from './reason-capture.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<ResponseOutcome | false> {
  const approval = await getPendingApproval(payload.questionId);
  if (!approval) return false;

  if (!(await isAuthorizedApprovalClick(approval, payload))) {
    log.warn('Ignoring unauthorized approval response', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
    });
    return 'refused';
  }

  return handleRegisteredApproval(approval, payload.value, clickerUserId(payload) ?? '', payload.accepted);
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
  accepted?: () => void,
): Promise<ResponseOutcome> {
  // The session that asked is gone: so is the request.
  if (!approval.session_id) {
    await deletePendingApproval(approval.approval_id);
    return 'closed';
  }
  const session = await getSession(approval.session_id);
  if (!session) {
    await deletePendingApproval(approval.approval_id);
    return 'closed';
  }

  // "Reject with reason…" — hold the row and capture the admin's next DM
  // instead of finalizing now. The agent is notified exactly once: after the
  // reason arrives, or after the sweep's timeout if the admin ghosts.
  if (selectedOption === REJECT_WITH_REASON_VALUE) {
    return (await armReasonCapture(approval, session, userId, accepted)) ? 'accepted' : 'ignored';
  }

  // Plain Reject (or any other non-approve value) — instant fast path. Only from
  // 'pending': a card click must not cut short a reason the admin is typing.
  if (selectedOption !== 'approve') {
    return (await finalizeReject(approval, session, userId, { from: 'pending', accepted })) ? 'accepted' : 'ignored';
  }

  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'approved'))) return 'ignored';
  // The decision is recorded: the card can show it while the action runs.
  accepted?.();

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
    return 'accepted';
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
  return 'accepted';
}

function clickerUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return namespacedUserId(payload.channelType, payload.userId);
}

export async function isAuthorizedApprovalClick(approval: PendingApproval, payload: ResponsePayload): Promise<boolean> {
  const userId = clickerUserId(payload);
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
