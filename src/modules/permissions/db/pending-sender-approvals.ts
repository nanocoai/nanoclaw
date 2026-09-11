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

export async function createPendingSenderApproval(row: PendingSenderApproval): Promise<void> {
  await getDb().run(
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
    row,
  );
}

export async function getPendingSenderApproval(id: string): Promise<PendingSenderApproval | undefined> {
  return getDb().get<PendingSenderApproval>('SELECT * FROM pending_sender_approvals WHERE id = ?', id);
}

export async function hasInFlightSenderApproval(messagingGroupId: string, senderIdentity: string): Promise<boolean> {
  const row = await getDb().get<{ x: number }>(
    'SELECT 1 AS x FROM pending_sender_approvals WHERE messaging_group_id = ? AND sender_identity = ?',
    messagingGroupId,
    senderIdentity,
  );
  return row !== undefined;
}

export async function deletePendingSenderApproval(id: string): Promise<void> {
  await getDb().run('DELETE FROM pending_sender_approvals WHERE id = ?', id);
}

// ── Decline stamps (decline_notify dedupe) ──
// The decline-and-notify flow persists "last declined at" per (messaging
// group, sender) by reusing this table's UNIQUE key — an id prefix
// distinguishes stamps from real card rows. Stamps never render a card and
// no click can resolve them (response handlers look up by exact id). A
// policy flip back to request_approval clears the stamp before carding
// (clearDeclineStamp in requestSenderApproval) so the UNIQUE key is free.
// The mirror collision (a card row left pending when the policy flipped TO
// decline_notify) is resolved by upsertDeclineStamp converting the row into
// the stamp shape — the card is obsolete once the policy no longer cards.

const DECLINE_STAMP_ID_PREFIX = 'decline:';

/** ISO timestamp of the last decline for this pair, if any. */
export async function getDeclineStampAt(messagingGroupId: string, senderIdentity: string): Promise<string | undefined> {
  const row = await getDb().get<{ created_at: string }>(
    `SELECT created_at FROM pending_sender_approvals
      WHERE messaging_group_id = ? AND sender_identity = ? AND id LIKE '${DECLINE_STAMP_ID_PREFIX}%'`,
    messagingGroupId,
    senderIdentity,
  );
  return row?.created_at;
}

/** Record (or refresh) the decline stamp. `agent_group_id` must reference a
 *  real agent group (FK). title/options_json keep their '' / '[]' defaults. */
export async function upsertDeclineStamp(stamp: {
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
}): Promise<void> {
  await getDb().run(
    `INSERT INTO pending_sender_approvals (
         id, messaging_group_id, agent_group_id, sender_identity,
         sender_name, original_message, approver_user_id, created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id, @sender_identity,
         @sender_name, @original_message, '', @created_at
       )
       ON CONFLICT(messaging_group_id, sender_identity) DO UPDATE SET
         id = excluded.id,
         created_at = excluded.created_at,
         sender_name = excluded.sender_name,
         original_message = excluded.original_message,
         approver_user_id = excluded.approver_user_id,
         title = excluded.title,
         options_json = excluded.options_json`,
    {
      id: `${DECLINE_STAMP_ID_PREFIX}${stamp.messaging_group_id}:${stamp.sender_identity}`,
      ...stamp,
      created_at: new Date().toISOString(),
    },
  );
}

/** Remove any decline stamp for this pair — real card rows are untouched. */
export async function clearDeclineStamp(messagingGroupId: string, senderIdentity: string): Promise<void> {
  await getDb().run(
    `DELETE FROM pending_sender_approvals
      WHERE messaging_group_id = ? AND sender_identity = ? AND id LIKE '${DECLINE_STAMP_ID_PREFIX}%'`,
    messagingGroupId,
    senderIdentity,
  );
}
