import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'task-model',
  up(db: Database.Database) {
    // Optional per-group model override for scheduled-task-only turns, so
    // watcher wakes can run on a cheap model without touching chat quality.
    db.prepare('ALTER TABLE container_configs ADD COLUMN task_model TEXT').run();
  },
};
