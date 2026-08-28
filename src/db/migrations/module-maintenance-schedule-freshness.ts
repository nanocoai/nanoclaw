import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * 2026-08-16 correction: a long-lived recurring wake session that had
 * already seen today's workday confirmed earlier in its own conversation
 * skipped calling get_workday_status on a later fire -- it went straight
 * to checking worker activity and sent an attendance message on a day
 * that, by then, was genuinely unconfirmed again. Trusting the agent to
 * always remember to call get_workday_status first (an instruction-only
 * fix) isn't enough on its own -- this table makes it structural.
 *
 * One row per session, tracking the last calendar date (in the
 * schedule's configured timezone) that session actually called
 * get_workday_status. get_worker_activity checks this before answering
 * on a conditional day: no fresh check for TODAY's date in THIS session
 * means it refuses, rather than letting worker-activity data (or the
 * agent's own memory) stand in for a workday confirmation it never
 * actually re-verified.
 *
 * Ported from old commit 824318ff, self-registered via registerMigration().
 */
export const moduleMaintenanceScheduleFreshness: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:schedule-freshness',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE maintenance_workday_status_checks (
        session_id   TEXT PRIMARY KEY,
        work_date    TEXT NOT NULL,
        checked_at   TEXT NOT NULL
      );
    `);
  },
};
