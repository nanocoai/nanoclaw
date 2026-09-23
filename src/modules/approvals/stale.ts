/**
 * Stale approval cleanup.
 *
 * Module-initiated approval cards (install_packages, cli_command, create_agent,
 * …) have no gateway TTL, and on a channel whose card replies can be lost (a
 * native adapter restarting, a newer card taking the reply) they would
 * otherwise sit at `pending` forever. Two ways out:
 *
 *   1. `sweepStaleApprovals` — the host sweep expires any card left unanswered
 *      for APPROVAL_TTL_MS.
 *   2. `rejectPendingApproval` — an explicit reject by id, backing
 *      `ncl approvals reject`, for clearing a card without its buttons.
 *
 * OneCLI credential approvals keep their own expiry (onecli-approvals.ts);
 * rejecting one by id resolves its in-memory decision the same way a click does.
 */
import { deletePendingApproval, getPendingApproval, getSession, getStalePendingApprovals } from '../../db/sessions.js';
import { log } from '../../log.js';
import { finalizeExpired, finalizeReject } from './finalize.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import { clampReason } from './reason-capture.js';

export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Host-sweep hook: expire module-initiated approvals unanswered for APPROVAL_TTL_MS. */
export async function sweepStaleApprovals(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - APPROVAL_TTL_MS).toISOString();
  const rows = await getStalePendingApprovals(cutoff, ONECLI_ACTION);
  let expired = 0;
  for (const approval of rows) {
    const session = approval.session_id ? await getSession(approval.session_id) : undefined;
    if (!session) {
      await deletePendingApproval(approval.approval_id);
      expired += 1;
      continue;
    }
    if (await finalizeExpired(approval, session)) expired += 1;
  }
  return expired;
}

export type RejectOutcome = 'rejected' | 'removed';

/**
 * Reject a pending approval by id. `removed` means there was no live session to
 * tell (the row is simply dropped); `rejected` means the requesting agent was
 * notified exactly as if the admin had pressed Reject. Throws when the id is
 * unknown or the approval is already being applied.
 */
export async function rejectPendingApproval(
  approvalId: string,
  userId: string,
  reason?: string,
): Promise<RejectOutcome> {
  const approval = await getPendingApproval(approvalId);
  if (!approval) throw new Error(`No pending approval with id ${approvalId}.`);

  if (approval.action === ONECLI_ACTION) {
    if (await resolveOneCLIApproval(approvalId, 'reject')) return 'rejected';
    await deletePendingApproval(approvalId);
    return 'removed';
  }

  if (approval.status !== 'pending' && approval.status !== 'awaiting_reason') {
    throw new Error(`Approval ${approvalId} is ${approval.status}, not pending — it cannot be rejected now.`);
  }

  const session = approval.session_id ? await getSession(approval.session_id) : undefined;
  if (!session) {
    await deletePendingApproval(approvalId);
    return 'removed';
  }

  const clamped = reason ? clampReason(reason) : '';
  if (!(await finalizeReject(approval, session, userId, clamped || undefined))) {
    throw new Error(`Approval ${approvalId} was resolved by someone else in the meantime.`);
  }
  log.info('Approval rejected by id', { approvalId, action: approval.action, userId });
  return 'rejected';
}
