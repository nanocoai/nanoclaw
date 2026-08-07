import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'container-configs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE container_configs (
        agent_group_id        TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        provider              TEXT,
        model                 TEXT,
        effort                TEXT,
        image_tag             TEXT,
        assistant_name        TEXT,
        max_messages_per_prompt INTEGER,
        skills                TEXT NOT NULL DEFAULT '"all"',
        mcp_servers           TEXT NOT NULL DEFAULT '{}',
        packages_apt          TEXT NOT NULL DEFAULT '[]',
        packages_npm          TEXT NOT NULL DEFAULT '[]',
        additional_mounts     TEXT NOT NULL DEFAULT '[]',
        updated_at            TEXT NOT NULL
      );
    `);
  },
};
