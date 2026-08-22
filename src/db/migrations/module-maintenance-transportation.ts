import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Worker registry + transportation-dependency fields for Maintenance
 * Coordinator. A separate migration (not folded into
 * module-maintenance-worker-state.ts) because worker_state was already
 * created and migrations are append-only history, not editable in place.
 *
 * `workers` — static-ish reference data: name, preferred language, and
 * whether this worker drives independently. `usual_transport_provider`
 * (self-referencing, nullable) captures a real operational fact Kirk gave
 * directly: some workers don't drive and normally travel with another
 * specific worker, not "whoever's free."
 *
 * `worker_state` gains three columns for the moment-to-moment picture:
 * how they got to where they are right now (`transport_mode`), who drove
 * them if not self-driven (`transported_by`), and whether they're
 * currently waiting on a ride (`awaiting_pickup`). This is data capture
 * only -- no dispatch/scheduling optimization logic ships in Phase 1.
 *
 * Ported from old commit 824318ff. Depends on worker_state
 * (module-maintenance-worker-state.ts) already existing -- registered
 * after it in src/modules/maintenance-worker-actions/index.ts's import
 * order, which the registerMigration() mechanism preserves deterministically
 * regardless of each migration's own `version` field (see
 * src/db/migrations/registry.test.ts's FK-dependency ordering test).
 */
export const moduleMaintenanceTransportation: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:transportation',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE workers (
        user_id                    TEXT PRIMARY KEY,
        name                       TEXT NOT NULL,
        preferred_language         TEXT NOT NULL DEFAULT 'en',
        role                       TEXT NOT NULL DEFAULT 'worker',
        can_drive_independently    INTEGER NOT NULL DEFAULT 1,
        usual_transport_provider   TEXT REFERENCES workers(user_id),
        created_at                 TEXT NOT NULL
      );

      ALTER TABLE worker_state ADD COLUMN transport_mode TEXT;
      ALTER TABLE worker_state ADD COLUMN transported_by TEXT;
      ALTER TABLE worker_state ADD COLUMN awaiting_pickup INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
