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
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      via an in-memory Promise — see onecli-approvals.ts.
 *
 * Click authorization is `mayResolve` over the hold's approver rule
 * (approver-rule.ts) — the one shared rule for every hold.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval, getPendingApproval, getSession } from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { approverRuleOf, mayResolve } from './approver-rule.js';
import { finalizeReject } from './finalize.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import { getApprovalHandler, notifyApprovalResolved, REJECT_WITH_REASON_VALUE } from './primitive.js';
import { armReasonCapture } from './reason-capture.js';

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  const approval = getPendingApproval(payload.questionId);
  if (!approval) return false;

  const clickerId = namespacedUserId(payload);
  if (!mayResolve(approverRuleOf(approval), clickerId)) {
    log.warn('Ignoring unauthorized approval response', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
    });
    return true;
  }

  if (approval.action === ONECLI_ACTION) {
    // The expiry/sweep path marks the row before awaiting its card edit. A
    // click in that window is already too late and must not delete the row or
    // emit a second terminal event; the owning path will finish both.
    if (approval.status === 'expired') return true;
    if (await resolveOneCLIApproval(payload.questionId, payload.value, clickerId ?? '')) {
      return true;
    }
    // Row exists but the in-memory resolver is gone (timer fired or the process
    // restarted before the click). End the durable lifecycle as a sweep: the
    // click cannot resume the credentialed request without its live Promise.
    deletePendingApproval(payload.questionId);
    await notifyApprovalResolved({ approval, session: null, outcome: 'sweep', userId: clickerId ?? '' });
    return true;
  }

  await handleRegisteredApproval(approval, payload.value, clickerId ?? '');
  return true;
}

async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  // Sessionless holds (sender admission) carry session_id null and resolve
  // without an agent to notify; a session-BOUND hold whose session vanished
  // is stale — drop it.
  const session: Session | null = approval.session_id ? (getSession(approval.session_id) ?? null) : null;
  if (approval.session_id && !session) {
    deletePendingApproval(approval.approval_id);
    return;
  }

  // "Reject with reason…" — hold the row and capture the admin's next DM
  // instead of finalizing now. The agent is notified exactly once: after the
  // reason arrives, or after the sweep's timeout if the admin ghosts.
  // Sessionless holds have nobody to relay a reason to — plain reject.
  if (selectedOption === REJECT_WITH_REASON_VALUE) {
    if (session) await armReasonCapture(approval, session, userId);
    else await finalizeReject(approval, null, userId);
    return;
  }

  // Plain Reject (or any other non-approve value) — instant fast path.
  if (selectedOption !== 'approve') {
    await finalizeReject(approval, session, userId);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const notify = session
    ? (text: string): void => {
        writeSessionMessage(session.agent_group_id, session.id, {
          id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: session.agent_group_id,
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
        });
      }
    : (): void => {};

  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    deletePendingApproval(approval.approval_id);
    await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
    if (session) await wakeContainer(session);
    return;
  }

  const payload = JSON.parse(approval.payload);
  try {
    await handler({ session, payload, approval, userId, notify });
    log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  deletePendingApproval(approval.approval_id);
  await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
  if (session) await wakeContainer(session);
}

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}
