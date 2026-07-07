import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'container-config-env',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}'").run();
  },
};
