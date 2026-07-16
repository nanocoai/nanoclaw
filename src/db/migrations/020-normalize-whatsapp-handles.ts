import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * One-time rewrite of all WhatsApp user handles stored in the old Baileys JID
 * form (e.g. `whatsapp:15551234567@s.whatsapp.net`) to the canonical bare-digit
 * form (`whatsapp:15551234567`) introduced in the fix for issue #3069.
 *
 * Background
 * ----------
 * Before this fix, the Baileys (native) WhatsApp adapter emitted the full JID
 * as the sender handle, while the WhatsApp Business Cloud adapter (Chat SDK
 * bridge) emitted the bare wa_id. Both paths stamp `channelType = 'whatsapp'`,
 * so the two resulting user IDs — `whatsapp:15551234567@s.whatsapp.net` vs
 * `whatsapp:15551234567` — were distinct rows in `users`, and roles / membership
 * granted on one form never applied on the other.
 *
 * Affected tables
 * ---------------
 *   users(id)                        — primary user identity key
 *   user_roles(user_id, granted_by)  — FK + "who granted this" audit column
 *   agent_group_members(user_id, added_by)
 *   user_dms(user_id)
 *   pending_sender_approvals(sender_identity, approver_user_id)
 *   pending_channel_approvals(approver_user_id)
 *
 * Strategy
 * --------
 * We need to rename the PK in `users`, which cascades to all FK columns.
 * SQLite doesn't support ON UPDATE CASCADE on FK definitions, and PRAGMA
 * foreign_keys must be OFF for the rename window (handled by
 * disableForeignKeys: true on this migration so the runner toggles the pragma
 * and runs foreign_key_check inside the transaction).
 *
 * For each JID-form user ID we:
 *   1. Derive the canonical ID (strip @s.whatsapp.net and :device suffix).
 *   2. If the canonical row already exists (can happen if a Cloud message
 *      arrived first), merge by re-pointing all FK children to the canonical
 *      row, then delete the JID row.
 *   3. If the canonical row does not exist, simply rename it with UPDATE.
 *
 * Idempotent: re-running after a partial failure is safe — rows already in
 * canonical form are skipped by the `WHERE id LIKE 'whatsapp:%@s.whatsapp.net'`
 * filter.
 */
export const migration020: Migration = {
  version: 20,
  name: 'normalize-whatsapp-handles',
  disableForeignKeys: true,

  up(db: Database.Database) {
    // Find every WhatsApp user still stored in JID form.
    const jidRows = db
      .prepare(`SELECT id FROM users WHERE id LIKE 'whatsapp:%@s.whatsapp.net'`)
      .all() as { id: string }[];

    if (jidRows.length === 0) return;

    for (const { id: jidId } of jidRows) {
      // Strip the JID suffix: "whatsapp:15551234567:12@s.whatsapp.net" → "whatsapp:15551234567"
      // Split on ':' → ["whatsapp", "15551234567:12@s.whatsapp.net"]
      // then strip the @... part from the second segment.
      const prefix = 'whatsapp:';
      const handle = jidId.slice(prefix.length); // e.g. "15551234567:12@s.whatsapp.net"
      const canonicalDigits = handle.split('@')[0].split(':')[0]; // "15551234567"
      const canonicalId = `${prefix}${canonicalDigits}`;

      if (canonicalId === jidId) continue; // already canonical (shouldn't happen given the LIKE filter)

      const canonicalExists = !!(db.prepare('SELECT 1 FROM users WHERE id = ?').get(canonicalId));

      if (canonicalExists) {
        // ── Merge: canonical row already exists — re-point FK children ──
        // user_roles
        db.prepare(
          `UPDATE OR IGNORE user_roles SET user_id = ? WHERE user_id = ?`,
        ).run(canonicalId, jidId);
        db.prepare(`DELETE FROM user_roles WHERE user_id = ?`).run(jidId);

        db.prepare(
          `UPDATE OR IGNORE user_roles SET granted_by = ? WHERE granted_by = ?`,
        ).run(canonicalId, jidId);
        db.prepare(`UPDATE user_roles SET granted_by = NULL WHERE granted_by = ?`).run(jidId);

        // agent_group_members
        db.prepare(
          `UPDATE OR IGNORE agent_group_members SET user_id = ? WHERE user_id = ?`,
        ).run(canonicalId, jidId);
        db.prepare(`DELETE FROM agent_group_members WHERE user_id = ?`).run(jidId);

        db.prepare(
          `UPDATE OR IGNORE agent_group_members SET added_by = ? WHERE added_by = ?`,
        ).run(canonicalId, jidId);
        db.prepare(`UPDATE agent_group_members SET added_by = NULL WHERE added_by = ?`).run(jidId);

        // user_dms
        db.prepare(
          `UPDATE OR IGNORE user_dms SET user_id = ? WHERE user_id = ?`,
        ).run(canonicalId, jidId);
        db.prepare(`DELETE FROM user_dms WHERE user_id = ?`).run(jidId);

        // pending_sender_approvals (may or may not exist depending on install)
        if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pending_sender_approvals'`).get()) {
          db.prepare(
            `UPDATE pending_sender_approvals SET sender_identity = ? WHERE sender_identity = ?`,
          ).run(canonicalId, jidId);
          db.prepare(
            `UPDATE pending_sender_approvals SET approver_user_id = ? WHERE approver_user_id = ?`,
          ).run(canonicalId, jidId);
        }

        // pending_channel_approvals (approver_user_id only — messaging_group_id is not a user id)
        if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pending_channel_approvals'`).get()) {
          db.prepare(
            `UPDATE pending_channel_approvals SET approver_user_id = ? WHERE approver_user_id = ?`,
          ).run(canonicalId, jidId);
        }

        // dropped_messages references user_id but has no FK constraint — best-effort update.
        if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dropped_messages'`).get()) {
          db.prepare(
            `UPDATE dropped_messages SET user_id = ? WHERE user_id = ?`,
          ).run(canonicalId, jidId);
        }

        // Now safe to drop the duplicate JID row.
        db.prepare(`DELETE FROM users WHERE id = ?`).run(jidId);
      } else {
        // ── Rename: no conflict — just update the PK and all FK columns ──
        // Insert under canonical id, carrying over all columns.
        db.prepare(
          `INSERT INTO users (id, kind, display_name, created_at) SELECT ?, kind, display_name, created_at FROM users WHERE id = ?`,
        ).run(canonicalId, jidId);

        // Re-point FK children.
        db.prepare(`UPDATE user_roles SET user_id = ? WHERE user_id = ?`).run(canonicalId, jidId);
        db.prepare(`UPDATE user_roles SET granted_by = ? WHERE granted_by = ?`).run(canonicalId, jidId);
        db.prepare(`UPDATE agent_group_members SET user_id = ? WHERE user_id = ?`).run(canonicalId, jidId);
        db.prepare(`UPDATE agent_group_members SET added_by = ? WHERE added_by = ?`).run(canonicalId, jidId);
        db.prepare(`UPDATE user_dms SET user_id = ? WHERE user_id = ?`).run(canonicalId, jidId);

        if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pending_sender_approvals'`).get()) {
          db.prepare(`UPDATE pending_sender_approvals SET sender_identity = ? WHERE sender_identity = ?`).run(canonicalId, jidId);
          db.prepare(`UPDATE pending_sender_approvals SET approver_user_id = ? WHERE approver_user_id = ?`).run(canonicalId, jidId);
        }

        if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='pending_channel_approvals'`).get()) {
          db.prepare(`UPDATE pending_channel_approvals SET approver_user_id = ? WHERE approver_user_id = ?`).run(canonicalId, jidId);
        }

        if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='dropped_messages'`).get()) {
          db.prepare(`UPDATE dropped_messages SET user_id = ? WHERE user_id = ?`).run(canonicalId, jidId);
        }

        // Delete the old JID-keyed row.
        db.prepare(`DELETE FROM users WHERE id = ?`).run(jidId);
      }
    }
  },
};
