import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * `away_mode_queue` table — the durable, ordered development-work queue for
 * Away Mode (Claude working independently on NanoClaw development while
 * Kirk is away, within a bounded authority scope; see away-mode/POLICY.md).
 *
 * Deliberately a small dedicated table rather than reusing the scheduled-
 * tasks system (`src/modules/scheduling/`): tasks are a cron/one-shot
 * scheduler with scheduling-only status (pending/paused/completed/
 * cancelled/failed) and no ordering or workflow-status concept. A dev
 * queue's needs -- ordered items, multi-step status transitions, human-
 * review checkpoints -- don't map onto that model without abusing it.
 *
 * Flexible/nested fields (dependencies, key_decisions, test_results,
 * kirk_questions) are stored as JSON text, mirroring how this codebase
 * already stores structured-but-variable data in a single column (e.g.
 * scheduled tasks' own `content` column) rather than fully normalizing
 * every sub-list into its own table.
 *
 * No credentials, tenant PII, or other sensitive/private information
 * belongs in any queue field -- see away-mode/POLICY.md.
 *
 * References away_mode_sessions(id) -- MUST be registered after
 * module-away-mode-sessions.ts. Ported from old commit 0fb28c04,
 * self-registered via registerMigration().
 */
export const moduleAwayModeQueue: ModuleMigration = {
  version: 1,
  name: 'module:away-mode:queue',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE away_mode_queue (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT REFERENCES away_mode_sessions(id),
        position            INTEGER NOT NULL,
        title               TEXT NOT NULL,
        goal                TEXT NOT NULL,
        authority_level     TEXT NOT NULL DEFAULT 'A',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        allowed_scope       TEXT NOT NULL DEFAULT '',
        production_exclusions TEXT NOT NULL DEFAULT '',
        dependencies        TEXT NOT NULL DEFAULT '[]',
        status              TEXT NOT NULL DEFAULT 'QUEUED',
        key_decisions        TEXT NOT NULL DEFAULT '[]',
        test_results         TEXT NOT NULL DEFAULT '[]',
        kirk_questions        TEXT NOT NULL DEFAULT '[]',
        next_action         TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );

      CREATE INDEX idx_away_mode_queue_session_status
        ON away_mode_queue(session_id, status);
    `);
  },
};
