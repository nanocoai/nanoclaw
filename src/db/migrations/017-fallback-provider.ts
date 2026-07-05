import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'fallback-provider',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN fallback_provider TEXT').run();
  },
};
