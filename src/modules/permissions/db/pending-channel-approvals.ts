/**
 * CRUD for pending_channel_approvals — the in-flight state for the
 * unknown-channel registration flow. A row exists while an owner-approval
 * card is outstanding; it's deleted on approve (after wiring is created)
 * or deny (after denied_at is set on the messaging_group).
 *
 * PRIMARY KEY on messaging_group_id gives free in-flight dedup. A second
 * mention/DM while a card is pending resolves via
 * `hasInFlightChannelApproval` in the request flow and drops silently
 * instead of spamming the owner.
 */
import { getDb } from '../../../db/connection.js';

export interface PendingChannelApproval {
  messaging_group_id: string;
  agent_group_id: string;
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

export function createPendingChannelApproval(row: PendingChannelApproval): void {
  getDb()
    .prepare(
      `INSERT INTO pending_channel_approvals (
         messaging_group_id, agent_group_id, original_message,
         approver_user_id, created_at, title, question, options_json
       )
       VALUES (
         @messaging_group_id, @agent_group_id, @original_message,
         @approver_user_id, @created_at, @title, @question, @options_json
       )`,
    )
    .run(row);
}

export function getPendingChannelApproval(messagingGroupId: string): PendingChannelApproval | undefined {
  return getDb()
    .prepare('SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?')
    .get(messagingGroupId) as PendingChannelApproval | undefined;
}

export function hasInFlightChannelApproval(messagingGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM pending_channel_approvals WHERE messaging_group_id = ?')
    .get(messagingGroupId) as { x: number } | undefined;
  return row !== undefined;
}

export function updatePendingChannelApprovalCard(
  messagingGroupId: string,
  title: string,
  question: string,
  optionsJson: string,
): void {
  getDb()
    .prepare(
      'UPDATE pending_channel_approvals SET title = ?, question = ?, options_json = ? WHERE messaging_group_id = ?',
    )
    .run(title, question, optionsJson, messagingGroupId);
}

export function deletePendingChannelApproval(messagingGroupId: string): void {
  getDb().prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?').run(messagingGroupId);
}
