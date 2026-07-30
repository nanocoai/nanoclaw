/**
 * Channel-instance dimension on messaging_groups.
 *
 * `instance` names the adapter instance that owns a chat — N adapters of one
 * platform (e.g. three Slack apps in one workspace) each get their own
 * messaging_groups rows. The default instance IS the channel type: every
 * existing row is backfilled with `instance = channel_type`, so all existing
 * lookups keep resolving the same rows with zero operator action. NOT NULL
 * (instead of nullable + partial unique index) keeps every lookup two-state:
 * "default instance" is just the literal value `channel_type`.
 *
 * Uniqueness relaxes from UNIQUE(channel_type, platform_id) to
 * UNIQUE(channel_type, platform_id, instance). SQLite cannot relax a
 * table-level UNIQUE in place — this requires the documented 12-step
 * recreate (new table → copy → DROP → RENAME, sqlite.org/lang_altertable.html).
 * DROP TABLE fails `FOREIGN KEY constraint failed` on live DBs because five
 * child tables REFERENCE messaging_groups(id) (messaging_group_agents,
 * user_dms, sessions, pending_sender_approvals, pending_channel_approvals) —
 * the exact failure that forced migration 011 to abandon its rebuild (see
 * its header). Hence `disableForeignKeys: true`: the runner toggles
 * foreign_keys=OFF around the transaction (the pragma is a no-op inside one)
 * and runs PRAGMA foreign_key_check inside it so violations roll back.
 *
 * Column list mirrors the live tip schema exactly (001 columns + 012's
 * denied_at) — verified against PRAGMA table_info on a freshly-migrated DB.
 * A recreate with a stale column list silently drops data.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'messaging-group-instance',
  disableForeignKeys: true,
  up: (db: Database.Database) => {
    // Idempotency guard per the 012 pattern.
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'instance')) return;

    db.exec(`
      CREATE TABLE messaging_groups_new (
        id                    TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        platform_id           TEXT NOT NULL,
        instance              TEXT NOT NULL,
        name                  TEXT,
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
        created_at            TEXT NOT NULL,
        denied_at             TEXT,
        UNIQUE(channel_type, platform_id, instance)
      );
      INSERT INTO messaging_groups_new
        (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at, denied_at)
        SELECT id, channel_type, platform_id, channel_type, name, is_group, unknown_sender_policy, created_at, denied_at
          FROM messaging_groups;
      DROP TABLE messaging_groups;
      ALTER TABLE messaging_groups_new RENAME TO messaging_groups;
    `);
  },
};
