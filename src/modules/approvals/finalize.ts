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
import { wakeContainer } from '../../container-runner.js';
import { deletePendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { notifyApprovalResolved } from './primitive.js';

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
): Promise<void> {
  const text = reason
    ? `Your ${approval.action} request was rejected by admin: "${reason}"`
    : `Your ${approval.action} request was rejected by admin.`;

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `appr-note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });

  log.info('Approval rejected', {
    approvalId: approval.approval_id,
    action: approval.action,
    userId,
    withReason: reason !== undefined,
  });

  deletePendingApproval(approval.approval_id);
  await notifyApprovalResolved({ approval, session, outcome: 'reject', userId });
  await wakeContainer(session);
}
