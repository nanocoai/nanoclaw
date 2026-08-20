/**
 * Unknown-sender approval flow. When `unknown_sender_policy = 'request_approval'`
 * a non-member message triggers a card to the most appropriate admin. An
 * in-flight entry in this table dedups concurrent attempts from the same
 * sender; the row is cleared on approve / deny.
 *
 * Previously this migration also rebuilt `messaging_groups` to flip the
 * column DEFAULT from `'strict'` to `'request_approval'`. Removed: the
 * rebuild failed SQLite's foreign-key integrity check at DROP time on live
 * DBs with existing FK references (sessions, user_dms, etc.), and `PRAGMA
 * foreign_keys` / `defer_foreign_keys` can't be toggled inside the
 * implicit migration transaction. The default-flip was cosmetic anyway —
 * every `createMessagingGroup` callsite passes `unknown_sender_policy`
 * explicitly, and the router's auto-create path was updated to hardcode
 * `'request_approval'` directly (see src/router.ts:123).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration011: Migration = {
  version: 11,
  name: 'pending-sender-approvals',
  sqliteOnly: true,
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_sender_approvals (
        id                   TEXT PRIMARY KEY,
        messaging_group_id   TEXT NOT NULL REFERENCES messaging_groups(id),
        agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
        sender_identity      TEXT NOT NULL,      -- namespaced user id (channel_type:handle)
        sender_name          TEXT,
        original_message     TEXT NOT NULL,      -- JSON serialized InboundEvent
        approver_user_id     TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        UNIQUE(messaging_group_id, sender_identity)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_sender_approvals_mg
        ON pending_sender_approvals(messaging_group_id);
    `);
  },
};
