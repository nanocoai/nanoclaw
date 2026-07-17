import { log } from '../../log.js';
import type { Migration } from './index.js';

interface LegacySenderApproval {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  sender_identity: string;
  sender_name: string | null;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  title: string;
  options_json: string;
}

/**
 * The hold-record contract lands on `pending_approvals` (guarded-actions
 * phase 1 — see the guarded-actions decisions doc, decision 5):
 *
 *   - `approver_rule` — who may resolve the hold: 'exclusive' (only
 *     `approver_user_id`, e.g. an a2a policy's named approver) or
 *     'admins-of-scope' (the admin chain of `agent_group_id`, plus the
 *     specific user the card was delivered to when `approver_user_id` is
 *     stamped — the sender/channel "named-or-admin" semantic).
 *   - `dedup_key` — in-flight dedup: while a pending row carries a key, a
 *     second request with the same key is dropped. The partial UNIQUE index
 *     enforces it at the DB level under concurrency, preserving the sender
 *     table's old UNIQUE(messaging_group_id, sender_identity) guarantee.
 *
 * Backfills: rows with a named approver were exclusive before this column
 * existed; `agent_group_id` is stamped from the requesting session so
 * click-auth no longer needs the session fallback.
 *
 * The legacy standalone `pending_sender_approvals` is dropped: sender
 * admission now holds through the approvals primitive (action
 * 'sender_admit'). Migration 022 adds a one-to-one detail row beneath that
 * master for structured sender queries and continuation data. Existing
 * standalone rows are converted into `sender_admit` masters before the old
 * table is removed; migration 022 then derives their detail rows.
 */
export const migration020: Migration = {
  version: 20,
  name: 'holds-approver-rule',
  up(db) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN approver_rule TEXT NOT NULL DEFAULT 'admins-of-scope';`);
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN dedup_key TEXT;`);
    // Partial UNIQUE preserves the dropped sender table's
    // UNIQUE(messaging_group_id, sender_identity): at most one live hold per
    // dedup key, so a concurrent duplicate request can't mint a second card.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_approvals_dedup
         ON pending_approvals(dedup_key) WHERE dedup_key IS NOT NULL;`,
    );
    db.exec(`UPDATE pending_approvals SET approver_rule = 'exclusive' WHERE approver_user_id IS NOT NULL;`);
    db.exec(
      `UPDATE pending_approvals
         SET agent_group_id = (SELECT s.agent_group_id FROM sessions s WHERE s.id = pending_approvals.session_id)
       WHERE agent_group_id IS NULL AND session_id IS NOT NULL;`,
    );

    const hasLegacySenderTable =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending_sender_approvals'").get() !==
      undefined;
    if (hasLegacySenderTable) {
      const legacyCount = (
        db.prepare('SELECT COUNT(*) AS count FROM pending_sender_approvals').get() as { count: number }
      ).count;
      const legacyRows = db
        .prepare(
          `SELECT psa.*
             FROM pending_sender_approvals psa
             JOIN messaging_groups mg ON mg.id = psa.messaging_group_id
             JOIN agent_groups ag ON ag.id = psa.agent_group_id`,
        )
        .all() as LegacySenderApproval[];
      if (legacyRows.length < legacyCount) {
        log.warn('Skipped orphaned legacy sender approvals during migration', {
          count: legacyCount - legacyRows.length,
        });
      }
      const insert = db.prepare(
        `INSERT OR IGNORE INTO pending_approvals
           (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status,
            title, options_json, approver_user_id, approver_rule, dedup_key)
         VALUES
           (@approvalId, NULL, @approvalId, 'sender_admit', @payload, @createdAt, @agentGroupId, 'pending',
            @title, @optionsJson, @approverUserId, 'admins-of-scope', @dedupKey)`,
      );

      for (const row of legacyRows) {
        let event: unknown = row.original_message;
        try {
          event = JSON.parse(row.original_message);
          // eslint-disable-next-line no-catch-all/no-catch-all -- malformed legacy JSON is retained as data so it cannot abort startup
        } catch {
          // Preserve the hold without aborting startup. Migration 022 will
          // retain the raw value; the continuation refuses malformed events.
        }
        insert.run({
          approvalId: row.id,
          payload: JSON.stringify({
            messagingGroupId: row.messaging_group_id,
            agentGroupId: row.agent_group_id,
            senderIdentity: row.sender_identity,
            senderName: row.sender_name,
            event,
          }),
          createdAt: row.created_at,
          agentGroupId: row.agent_group_id,
          title: row.title,
          optionsJson: row.options_json,
          approverUserId: row.approver_user_id,
          dedupKey: `sender_admit:${row.messaging_group_id}:${row.sender_identity}`,
        });
      }
    }

    db.exec(`DROP INDEX IF EXISTS idx_pending_sender_approvals_mg;`);
    db.exec(`DROP TABLE IF EXISTS pending_sender_approvals;`);
  },
};
