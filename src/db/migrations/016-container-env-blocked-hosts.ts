import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'container-env-blocked-hosts',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'").run();
    db.prepare("ALTER TABLE container_configs ADD COLUMN blocked_hosts TEXT NOT NULL DEFAULT '[]'").run();
  },
};
