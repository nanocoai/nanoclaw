import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration008: Migration = {
  version: 8,
  name: 'dropped-messages',
  sqliteOnly: true,
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS unregistered_senders (
        channel_type    TEXT NOT NULL,
        platform_id     TEXT NOT NULL,
        user_id         TEXT,
        sender_name     TEXT,
        reason          TEXT NOT NULL,
        messaging_group_id TEXT,
        agent_group_id  TEXT,
        message_count   INTEGER NOT NULL DEFAULT 1,
        first_seen      TEXT NOT NULL,
        last_seen       TEXT NOT NULL,
        PRIMARY KEY (channel_type, platform_id)
      );

      CREATE INDEX IF NOT EXISTS idx_unregistered_senders_last_seen
        ON unregistered_senders(last_seen);
    `);
  },
};
