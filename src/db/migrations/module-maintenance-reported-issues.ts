import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Worker-reported maintenance issues -- captured immediately when a worker
 * tells Maintenance Coordinator about a new problem, rather than waiting
 * for Kirk to enter it. A report alone never authorizes a trip, purchase,
 * or reprioritization -- `kirk_decision` records what Kirk actually said
 * to do about it, via the maintenance_decision card
 * (src/modules/maintenance-decisions/, not yet ported -- see
 * src/modules/maintenance-worker-actions/index.ts's header), before
 * anything else happens.
 *
 * Ported from old commit 824318ff, pulled forward as source data for
 * get_worker_activity_history (Pepper->MC historical queries).
 */
export const moduleMaintenanceReportedIssues: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:reported-issues',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE reported_issues (
        id                   TEXT PRIMARY KEY,
        worker_user_id       TEXT NOT NULL,
        property_reference   TEXT NOT NULL,
        unit                 TEXT,
        description          TEXT NOT NULL,
        urgency              TEXT NOT NULL DEFAULT 'normal',
        photo_path           TEXT,
        reported_at          TEXT NOT NULL,
        source_message_id    TEXT,
        status               TEXT NOT NULL DEFAULT 'new',
        kirk_decision        TEXT,
        decided_at           TEXT
      );
      CREATE INDEX idx_reported_issues_worker ON reported_issues(worker_user_id, reported_at);
      CREATE INDEX idx_reported_issues_status ON reported_issues(status);
    `);
  },
};
