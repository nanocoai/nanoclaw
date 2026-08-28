import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Worker time/activity tracking for Maintenance Coordinator. Two DB
 * patterns per the Phase 1 architecture plan, mirroring the
 * lease_document_deliveries (audit) / away_mode_sessions (current-state)
 * split already used elsewhere in this codebase:
 *
 * `worker_time_events` — append-only, NEVER updated or deleted. A time
 * correction is a new row with `corrects_event_id` pointing at the
 * original; the original stays exactly as recorded. Current clock status
 * is derived by reading each worker's latest event, not stored separately.
 *
 * `worker_activity_log` — append-only history of everything else worth a
 * durable record (location reports, job start/stop, material requests,
 * clarifications asked/answered, completion reports).
 *
 * `worker_state` — the one mutable, latest-value table: what a worker is
 * doing *right now*. `pending_clarification` is Phase 1's entire
 * non-response mechanism — just enough to remember "already asked, still
 * waiting" so the agent doesn't ask twice. Staged escalation/reminders are
 * explicitly deferred (see away-mode's reason-capture.ts for the pattern
 * to reuse when that's built).
 *
 * Ported from old commit 824318ff's module-maintenance-worker-state.ts,
 * pulled forward as a prerequisite for the Pepper->MC historical-query
 * capabilities (get_worker_time_history / get_worker_activity_history)
 * rather than reinventing a parallel schema. Self-registered via
 * registerMigration() from src/modules/maintenance-worker-actions/index.ts
 * -- MUST be registered before module-maintenance-transportation.ts, whose
 * migration ALTERs this file's worker_state table.
 */
export const moduleMaintenanceWorkerState: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:worker-state',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE worker_time_events (
        id                  TEXT PRIMARY KEY,
        worker_user_id      TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        occurred_at         TEXT NOT NULL,
        recorded_at         TEXT NOT NULL,
        source_message_id   TEXT,
        corrects_event_id   TEXT REFERENCES worker_time_events(id),
        note                TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_worker_time_events_worker ON worker_time_events(worker_user_id, occurred_at);

      CREATE TABLE worker_activity_log (
        id                  TEXT PRIMARY KEY,
        worker_user_id      TEXT NOT NULL,
        activity_type       TEXT NOT NULL,
        detail              TEXT NOT NULL DEFAULT '',
        occurred_at         TEXT NOT NULL,
        source_message_id   TEXT
      );
      CREATE INDEX idx_worker_activity_log_worker ON worker_activity_log(worker_user_id, occurred_at);

      CREATE TABLE worker_state (
        worker_user_id                TEXT PRIMARY KEY,
        clocked_in                    INTEGER NOT NULL DEFAULT 0,
        current_location_reported     TEXT,
        current_location_reported_at  TEXT,
        active_job_reference          TEXT,
        pending_clarification         TEXT,
        last_activity_at              TEXT NOT NULL
      );
    `);
  },
};
