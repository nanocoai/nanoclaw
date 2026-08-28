import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Durable record of which conditional days (Saturday, and any other
 * non-fixed day) were actually confirmed as active workdays, and why.
 *
 * Fixed workdays (Mon-Fri) need no row here -- they're always active,
 * per groups/maintenance-coordinator/schedule-config.json. Conditional
 * days default to inactive; a row here is the one thing that flips a
 * specific date to active, evidenced by Kirk's own word, a worker
 * checking in, or a known assignment -- never inferred, never guessed,
 * and never re-derived from scratch on every hourly wake once confirmed
 * (see get_workday_status / mark_workday_active).
 *
 * work_date is always host-resolved from real time at the moment of
 * confirmation (in the schedule's configured timezone), never supplied
 * by the agent -- the same "never trust the LLM's own claim about facts
 * it could get wrong" discipline used for sender identity elsewhere in
 * this module.
 *
 * Ported from old commit 824318ff, self-registered via registerMigration().
 */
export const moduleMaintenanceSchedule: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:schedule',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE maintenance_confirmed_workdays (
        work_date      TEXT PRIMARY KEY,
        confirmed_by   TEXT NOT NULL,
        reason         TEXT NOT NULL,
        confirmed_at   TEXT NOT NULL
      );
    `);
  },
};
