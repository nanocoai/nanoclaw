import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'context-messages',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs
        ADD COLUMN context_messages INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE container_configs
        ADD COLUMN context_messages_max INTEGER NOT NULL DEFAULT 0;

      CREATE TABLE messaging_group_messages (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        messaging_group_id  TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        thread_id           TEXT,
        direction           TEXT NOT NULL,
        source_id           TEXT,
        sender_name         TEXT,
        sender_id           TEXT,
        agent_group_id      TEXT REFERENCES agent_groups(id) ON DELETE SET NULL,
        text                TEXT,
        has_attachments     INTEGER NOT NULL DEFAULT 0,
        ts                  TEXT NOT NULL,
        UNIQUE(messaging_group_id, source_id, direction)
      );

      CREATE INDEX idx_mgm_lookup
        ON messaging_group_messages(messaging_group_id, thread_id, id);

      CREATE INDEX idx_mgm_retention
        ON messaging_group_messages(messaging_group_id, id);

      CREATE TABLE agent_group_message_cursors (
        agent_group_id      TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        messaging_group_id  TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
        thread_id           TEXT NOT NULL DEFAULT '',
        last_seen_id        INTEGER NOT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, messaging_group_id, thread_id)
      );
    `);
  },
};
