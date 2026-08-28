import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Job-completion records for Maintenance Coordinator. Written by a host-
 * side MCP tool that copies the completion photo out of the session's
 * ephemeral `/workspace/inbox/<messageId>/<filename>` (never cleaned up
 * automatically, not a safe permanent home) into durable storage, and
 * records this row. No Trello write happens from this table in Phase 1 --
 * Kirk reviews completions and closes cards himself.
 *
 * Ported from old commit 824318ff, pulled forward as source data for
 * get_worker_activity_history (Pepper->MC historical queries).
 */
export const moduleMaintenanceCompletions: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:completions',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE job_completions (
        id                  TEXT PRIMARY KEY,
        job_reference       TEXT NOT NULL,
        worker_user_id      TEXT NOT NULL,
        reported_at         TEXT NOT NULL,
        photo_path          TEXT,
        status              TEXT NOT NULL DEFAULT 'reported',
        source_message_id   TEXT
      );
      CREATE INDEX idx_job_completions_job ON job_completions(job_reference);
    `);
  },
};
