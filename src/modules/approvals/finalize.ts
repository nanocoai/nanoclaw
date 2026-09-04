/**
 * Shared "finalize a rejected approval" path.
 *
 * Three entry points land here so they relay one message and clean up
 * identically:
 *   1. The instant Reject button            (response-handler.ts)
 *   2. A captured Reject-with-reason reply   (reason-capture.ts)
 *   3. The host-sweep ghost finalizer        (reason-capture.ts, via host-sweep)
 *
 * Kept in its own leaf file so both response-handler.ts and reason-capture.ts
 * can import it without an import cycle (finalize → primitive only).
 */
import { requestWake } from '../../request-wake.js';
import { deletePendingApproval, transitionPendingApprovalStatus } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { getUserRoles } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';
import { notifyApprovalResolved } from './primitive.js';

async function approverLabel(userId: string): Promise<string> {
  const displayName = (await getUser(userId))?.display_name?.trim();
  if (displayName) return displayName;
  const roles = await getUserRoles(userId);
  if (roles.some((role) => role.role === 'owner')) return 'An owner';
  return 'An admin';
}

/**
 * Notify the requesting agent that its action was rejected, drop the pending
 * row, fire approval-resolved callbacks, and wake the container.
 *
 * When `reason` is provided it's appended to the agent-facing note with generic
 * attribution — the why, not the who (the rejecting admin may belong to a
 * different owner than the requesting agent). Callers are responsible for
 * clamping the reason length before passing it in.
 */
export async function finalizeReject(
  approval: PendingApproval,
  session: Session,
  userId: string,
  reason?: string,
  expectedStatus: 'pending' | 'awaiting_reason' = approval.status === 'awaiting_reason' ? 'awaiting_reason' : 'pending',
): Promise<boolean> {
  if (!(await transitionPendingApprovalStatus(approval.approval_id, expectedStatus, 'rejected'))) return false;

  const text = reason
    ? `Your ${approval.action} request was rejected by admin: "${reason}"`
    : `Your ${approval.action} request was rejected by admin.`;

  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });

  if (approval.action === 'a2a_message_gate') {
    try {
      const payload = JSON.parse(approval.payload) as Record<string, unknown>;
      const sourceName = typeof payload.source_name === 'string' ? payload.source_name : session.agent_group_id;
      const targetName =
        typeof payload.target_name === 'string'
          ? payload.target_name
          : typeof payload.platform_id === 'string'
            ? payload.platform_id
            : 'the target agent';
      const noticeText = `${await approverLabel(userId)} rejected ${sourceName}'s message to ${targetName}.${reason !== undefined ? ` Reason: ${reason}` : ''}`;
      const { notifySource } = await import('../agent-to-agent/notify-source.js');
      await notifySource(session.id, noticeText);
    } catch (err) {
      log.warn('Could not notify source about rejected agent message', {
        approvalId: approval.approval_id,
        err,
      });
    }
  }

  log.info('Approval rejected', {
    approvalId: approval.approval_id,
    action: approval.action,
    userId,
    withReason: reason !== undefined,
  });

  await deletePendingApproval(approval.approval_id);
  await notifyApprovalResolved({ approval, session, outcome: 'reject', userId });
  await requestWake(session, 'approval-response');
  return true;
}
