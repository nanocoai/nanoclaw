/**
 * CRUD for pending_sender_approvals — the in-flight state for the
 * request_approval unknown-sender flow. Rows are created when an unknown
 * sender writes into a wired messaging group with that policy, and are
 * deleted on admin approve (after adding the user as a member) or deny.
 *
 * UNIQUE(messaging_group_id, sender_identity) enforces in-flight dedup:
 * a retry / second message from the same unknown sender while a card is
 * still pending is silently dropped instead of spamming the admin.
 */
import { getDb } from '../../../db/connection.js';

export interface PendingSenderApproval {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  /** Card title shown at creation and re-used by getAskQuestionRender on click. */
  title: string;
  /** Original card body retained when the approval reaches a terminal state. */
  question: string;
  /** Normalized options (JSON-encoded NormalizedOption[]) — same shape persisted on pending_approvals. */
  options_json: string;
}

export function createPendingSenderApproval(row: PendingSenderApproval): void {
  getDb()
    .prepare(
      `INSERT INTO pending_sender_approvals (
         id, messaging_group_id, agent_group_id, sender_identity,
         sender_name, original_message, approver_user_id, created_at,
         title, question, options_json
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id, @sender_identity,
         @sender_name, @original_message, @approver_user_id, @created_at,
         @title, @question, @options_json
       )`,
    )
    .run(row);
}

export function getPendingSenderApproval(id: string): PendingSenderApproval | undefined {
  return getDb().prepare('SELECT * FROM pending_sender_approvals WHERE id = ?').get(id) as
    | PendingSenderApproval
    | undefined;
}

export function hasInFlightSenderApproval(messagingGroupId: string, senderIdentity: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM pending_sender_approvals WHERE messaging_group_id = ? AND sender_identity = ?')
    .get(messagingGroupId, senderIdentity) as { x: number } | undefined;
  return row !== undefined;
}

export function deletePendingSenderApproval(id: string): void {
  getDb().prepare('DELETE FROM pending_sender_approvals WHERE id = ?').run(id);
}
