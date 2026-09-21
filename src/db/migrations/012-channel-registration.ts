/**
 * Unknown-channel registration flow.
 *
 * When a channel that isn't wired to any agent group receives a mention or
 * DM, the router escalates to the owner for approval before wiring. Approve
 * creates a `messaging_group_agents` row (with conservative defaults) and
 * replays the triggering event. Deny marks the channel denied forever
 * (stored as a timestamp on `messaging_groups.denied_at`) so future
 * messages on that channel drop silently without re-prompting.
 *
 * Two changes:
 *   1. `messaging_groups.denied_at TEXT NULL` — set on deny, checked in the
 *      router before re-escalating. ALTER TABLE ADD COLUMN is FK-safe
 *      unlike the table rebuild that bit us in migration 011.
 *   2. `pending_channel_approvals` table. PRIMARY KEY on
 *      `messaging_group_id` gives free in-flight dedup — a second mention
 *      while the card is pending is silently dropped by INSERT OR IGNORE,
 *      preventing card spam.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration012: Migration = {
  version: 12,
  name: 'channel-registration',
  sqliteOnly: true,
  up: (db: Database.Database) => {
    // 1. Add denied_at to messaging_groups. Idempotent guard in case the
    //    column was added by some other path before this migration ran.
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'denied_at')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN denied_at TEXT`);
    }

    // 2. pending_channel_approvals.
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_channel_approvals (
        messaging_group_id   TEXT PRIMARY KEY REFERENCES messaging_groups(id),
        agent_group_id       TEXT NOT NULL REFERENCES agent_groups(id),
                             -- The agent the approved wiring will target.
                             -- Picked at request time (currently: earliest
                             -- agent_group by created_at).
        original_message     TEXT NOT NULL,      -- JSON serialized InboundEvent
        approver_user_id     TEXT NOT NULL,
        created_at           TEXT NOT NULL
      );
    `);
  },
};
