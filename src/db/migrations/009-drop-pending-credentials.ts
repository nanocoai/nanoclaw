import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration009: Migration = {
  version: 9,
  name: 'drop-pending-credentials',
  sqliteOnly: true,
  up: (db: Database.Database) => {
    db.exec(`
      DROP INDEX IF EXISTS idx_pending_credentials_status;
      DROP TABLE IF EXISTS pending_credentials;
    `);
  },
};
