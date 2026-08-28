import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * `away_mode_sessions` table — one row per Away Mode activation. Records
 * what Kirk authorized (authority level, special instructions, production
 * exclusions, which queue items were active) at start time, and how it
 * ended. See away-mode/POLICY.md for what each field means operationally.
 *
 * Registered before module-away-mode-queue.ts (which references it) --
 * MUST be imported/registered first in
 * src/modules/away-mode-decisions/index.ts's import order, which
 * registerMigration() preserves deterministically (see
 * src/db/migrations/registry.test.ts's FK-dependency ordering test).
 *
 * Ported from old commit 0fb28c04, self-registered via registerMigration().
 */
export const moduleAwayModeSessions: ModuleMigration = {
  version: 1,
  name: 'module:away-mode:sessions',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE away_mode_sessions (
        id                     TEXT PRIMARY KEY,
        started_at             TEXT NOT NULL,
        stopped_at             TEXT,
        authority_level        TEXT NOT NULL DEFAULT 'A',
        special_instructions   TEXT NOT NULL DEFAULT '',
        production_exclusions  TEXT NOT NULL DEFAULT '',
        deployment_allowlist   TEXT NOT NULL DEFAULT '[]',
        status                 TEXT NOT NULL DEFAULT 'ACTIVE'
      );
    `);
  },
};
