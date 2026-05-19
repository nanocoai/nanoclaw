import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'container-config-provider-auth',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN model_provider TEXT;
      ALTER TABLE container_configs ADD COLUMN auth_mode TEXT;
    `);
  },
};
