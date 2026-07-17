import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Replace the operator-facing pending-hold read model.
 *
 * Migration 021 calls this before sender detail storage exists. Migration
 * 022 calls it again after creating that table, adding structured sender
 * fields without changing the lifecycle master. Keeping the UNION definition
 * here prevents the two migrations from drifting.
 */
export function replaceApprovalHoldsView(db: Database.Database, includeSenderDetails: boolean): void {
  const senderMessagingGroup = includeSenderDetails ? 'psad.messaging_group_id' : 'NULL';
  const senderIdentity = includeSenderDetails ? 'psad.sender_identity' : 'NULL';
  const senderName = includeSenderDetails ? 'psad.sender_name' : 'NULL';
  const senderJoin = includeSenderDetails
    ? 'LEFT JOIN pending_sender_approval_details psad ON psad.approval_id = pa.approval_id'
    : '';

  db.exec('DROP VIEW IF EXISTS approval_holds;');
  // `rowid` is an explicit ISO timestamp so the generic read-only CLI
  // resource can retain its newest-first ordering over this UNION view.
  db.exec(`
    CREATE VIEW approval_holds AS
    SELECT
      pa.created_at AS rowid,
      pa.approval_id,
      pa.session_id,
      pa.request_id,
      pa.action,
      pa.payload,
      pa.created_at,
      pa.agent_group_id,
      ${senderMessagingGroup} AS messaging_group_id,
      ${senderIdentity} AS subject_user_id,
      ${senderName} AS subject_name,
      pa.channel_type,
      pa.platform_id,
      pa.platform_message_id,
      pa.expires_at,
      pa.status,
      pa.title,
      pa.options_json,
      pa.approver_user_id,
      pa.approver_rule,
      pa.dedup_key
    FROM pending_approvals pa
    ${senderJoin}
    UNION ALL
    SELECT
      pca.created_at AS rowid,
      pca.messaging_group_id AS approval_id,
      NULL AS session_id,
      pca.messaging_group_id AS request_id,
      'channel_registration' AS action,
      json_object('messagingGroupId', pca.messaging_group_id) AS payload,
      pca.created_at,
      pca.agent_group_id,
      pca.messaging_group_id,
      NULL AS subject_user_id,
      NULL AS subject_name,
      NULL AS channel_type,
      NULL AS platform_id,
      NULL AS platform_message_id,
      NULL AS expires_at,
      'pending' AS status,
      pca.title,
      pca.options_json,
      pca.approver_user_id,
      'admins-of-scope' AS approver_rule,
      NULL AS dedup_key
    FROM pending_channel_approvals pca;
  `);
}

/**
 * One read model for "what is pending now?" without forcing the channel
 * flow's multi-step continuation into pending_approvals. Kept separate from
 * migration 020 so installs that already exercised the feature branch still
 * receive the view on their next startup.
 */
export const migration021: Migration = {
  version: 21,
  name: 'approval-holds-view',
  up(db) {
    replaceApprovalHoldsView(db, false);
  },
};
