import type { Migration } from './index.js';

/** Keep the SQLite 64-bit integer contract on existing PostgreSQL tables. */
export const migration025: Migration = {
  version: 25,
  name: 'host-coordination-integer-width',
  async up(db) {
    if (db.dialect !== 'postgres') return;
    await db.exec(`
      ALTER TABLE host_instances ALTER COLUMN pid TYPE BIGINT;
      ALTER TABLE session_claims ALTER COLUMN incarnation TYPE BIGINT;
      ALTER TABLE delivery_attempts ALTER COLUMN attempts TYPE BIGINT;
    `);
  },
};
