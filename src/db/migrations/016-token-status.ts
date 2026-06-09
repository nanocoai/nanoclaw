import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'token-status',
  up(db: Database.Database) {
    db.prepare(
      `
      CREATE TABLE token_status (
        agent_group_id TEXT PRIMARY KEY,
        checked_at     INTEGER NOT NULL,
        expires_at     INTEGER,
        minutes_left   REAL,
        status         TEXT NOT NULL,
        refreshed_at   INTEGER
      )
    `,
    ).run();
  },
};
