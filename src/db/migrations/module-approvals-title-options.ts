import type { Migration } from './index.js';

/**
 * Retroactive schema fix: earlier migration 003 was edited after it had
 * already been applied in the wild, adding `title` and `options_json`
 * columns to its CREATE TABLE statement. Installs that ran 003 before the
 * edit don't have those columns, and `createPendingApproval` (which
 * inserts into both) fails with "no such column" at runtime.
 *
 * This migration adds the missing columns via ALTER TABLE so old installs
 * catch up. On a fresh install that runs 003 at its current definition,
 * the ALTER statements will fail harmlessly (column already exists) and
 * we swallow the error per-column.
 */
// Retains the original `name` ('pending-approvals-title-options') so
// existing DBs that already recorded this migration don't re-run it. The
// module- prefix lives on the filename / export identifier only.
export const moduleApprovalsTitleOptions: Migration = {
  version: 7,
  name: 'pending-approvals-title-options',
  sqliteOnly: true,
  up(db) {
    const addIfMissing = (col: string, sql: string): void => {
      try {
        db.exec(sql);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('duplicate column') || msg.includes('already exists')) {
          // Fresh install — column already added by the current 003
          // definition. Nothing to do.
          return;
        }
        throw err;
      }
      void col;
    };

    addIfMissing('title', `ALTER TABLE pending_approvals ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
    addIfMissing('options_json', `ALTER TABLE pending_approvals ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'`);
  },
};
