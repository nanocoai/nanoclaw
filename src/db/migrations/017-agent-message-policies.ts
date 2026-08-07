import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/** Per-message approval gate on an agent-to-agent connection; no row = free flow. */
export const migration017: Migration = {
  version: 17,
  name: 'agent-message-policies',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE agent_message_policies (
        from_agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
        to_agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
        approver            TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        PRIMARY KEY (from_agent_group_id, to_agent_group_id)
      );
    `);
  },
};
