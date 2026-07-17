import { getDb } from '../../../db/connection.js';

/**
 * Action-specific continuation/query data for a sender-admission hold.
 * Lifecycle state lives only on the referenced pending_approvals master.
 */
export interface PendingSenderApprovalDetail {
  approval_id: string;
  messaging_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
}

export function createPendingSenderApprovalDetail(detail: PendingSenderApprovalDetail): void {
  getDb()
    .prepare(
      `INSERT INTO pending_sender_approval_details
         (approval_id, messaging_group_id, sender_identity, sender_name, original_message)
       VALUES (@approval_id, @messaging_group_id, @sender_identity, @sender_name, @original_message)`,
    )
    .run(detail);
}

export function getPendingSenderApprovalDetail(approvalId: string): PendingSenderApprovalDetail | undefined {
  return getDb().prepare('SELECT * FROM pending_sender_approval_details WHERE approval_id = ?').get(approvalId) as
    | PendingSenderApprovalDetail
    | undefined;
}
