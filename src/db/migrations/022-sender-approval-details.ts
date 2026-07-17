import { log } from '../../log.js';
import type { Migration } from './index.js';
import { replaceApprovalHoldsView } from './021-approval-holds-view.js';

interface SenderHoldRow {
  approval_id: string;
  payload: string;
}

interface SenderHoldPayload {
  messagingGroupId?: unknown;
  senderIdentity?: unknown;
  senderName?: unknown;
  event?: unknown;
}

/**
 * Sender admission uses a master/detail model:
 *
 *   pending_approvals                    lifecycle/auth/status/dedup master
 *       └─ pending_sender_approval_details  sender continuation + query data
 *
 * The child cannot outlive its master and does not duplicate lifecycle
 * columns. Its `(messaging_group_id, sender_identity)` constraint retains the
 * sender-specific uniqueness invariant in addition to the master's generic
 * dedup key.
 *
 * Feature-branch installs may already have sender_admit master rows written
 * after migration 020, so valid in-flight rows are backfilled from their
 * immutable payload snapshots. Malformed/orphaned snapshots stay resolvable
 * as generic holds but cannot safely run the sender continuation.
 */
export const migration022: Migration = {
  version: 22,
  name: 'sender-approval-details',
  up(db) {
    db.exec(`
      CREATE TABLE pending_sender_approval_details (
        approval_id        TEXT PRIMARY KEY REFERENCES pending_approvals(approval_id) ON DELETE CASCADE,
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        sender_identity    TEXT NOT NULL,
        sender_name        TEXT,
        original_message   TEXT NOT NULL,
        UNIQUE(messaging_group_id, sender_identity)
      );
      CREATE INDEX idx_pending_sender_approval_details_mg
        ON pending_sender_approval_details(messaging_group_id);
    `);

    const rows = db
      .prepare("SELECT approval_id, payload FROM pending_approvals WHERE action = 'sender_admit'")
      .all() as SenderHoldRow[];
    const insert = db.prepare(
      `INSERT OR IGNORE INTO pending_sender_approval_details
         (approval_id, messaging_group_id, sender_identity, sender_name, original_message)
       VALUES (@approvalId, @messagingGroupId, @senderIdentity, @senderName, @originalMessage)`,
    );
    const messagingGroupExists = db.prepare('SELECT 1 FROM messaging_groups WHERE id = ?');
    let skipped = 0;

    for (const row of rows) {
      let payload: SenderHoldPayload;
      try {
        payload = JSON.parse(row.payload) as SenderHoldPayload;
        // eslint-disable-next-line no-catch-all/no-catch-all -- malformed persisted JSON is an invalid backfill candidate, not a startup failure
      } catch {
        skipped += 1;
        continue;
      }
      const originalMessage = JSON.stringify(payload.event);
      if (
        typeof payload.messagingGroupId !== 'string' ||
        typeof payload.senderIdentity !== 'string' ||
        originalMessage === undefined ||
        (payload.senderName !== null && payload.senderName !== undefined && typeof payload.senderName !== 'string') ||
        messagingGroupExists.get(payload.messagingGroupId) === undefined
      ) {
        skipped += 1;
        continue;
      }
      insert.run({
        approvalId: row.approval_id,
        messagingGroupId: payload.messagingGroupId,
        senderIdentity: payload.senderIdentity,
        senderName: payload.senderName ?? null,
        originalMessage,
      });
    }

    if (skipped > 0) {
      log.warn('Skipped malformed sender approval detail backfills', { count: skipped });
    }

    replaceApprovalHoldsView(db, true);
  },
};
