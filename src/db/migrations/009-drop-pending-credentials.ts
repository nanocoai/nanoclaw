import type { ICentralDb } from '../central/types.js';
import type { Migration } from './index.js';
import type { MigrationContext } from './helpers.js';

export const migration009: Migration = {
  version: 9,
  name: 'drop-pending-credentials',
  up(db: ICentralDb, ctx: MigrationContext) {
    if (ctx.dialect === 'sqlite') {
      db.exec(`
        DROP INDEX IF EXISTS idx_pending_credentials_status;
        DROP TABLE IF EXISTS pending_credentials;
      `);
      return;
    }
    db.exec('DROP TABLE IF EXISTS pending_credentials');
  },
};
