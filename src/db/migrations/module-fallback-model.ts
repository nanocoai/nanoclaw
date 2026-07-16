import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const moduleFallbackModel: Migration = {
  version: 21,
  name: 'fallback-state-model',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE fallback_state ADD COLUMN backup_model TEXT').run();
  },
};
