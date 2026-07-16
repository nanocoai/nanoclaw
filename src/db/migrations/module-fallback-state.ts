import type { Migration } from './index.js';

/**
 * `fallback_state` — single-row (id=1) global state for the LLM fallback
 * module. Persisted so a host restart resumes in whatever state it left off
 * (active/inactive, auto/forced, next retry time) rather than forgetting the
 * switch ever happened.
 */
export const moduleFallbackState: Migration = {
  version: 19,
  name: 'fallback-state',
  up(db) {
    db.exec(`
      CREATE TABLE fallback_state (
        id                 INTEGER PRIMARY KEY CHECK (id = 1),
        active             INTEGER NOT NULL DEFAULT 0,
        mode               TEXT,
        classification     TEXT,
        reason             TEXT,
        backup_provider    TEXT,
        entered_at         TEXT,
        reset_at           TEXT,
        next_retry_at      TEXT,
        retry_count        INTEGER NOT NULL DEFAULT 0,
        probing            INTEGER NOT NULL DEFAULT 0,
        probe_message_id   TEXT,
        probe_session_id   TEXT,
        probe_started_at   TEXT,
        origin_session_id  TEXT,
        origin_group_id    TEXT,
        last_error         TEXT,
        updated_at         TEXT NOT NULL
      );

      INSERT INTO fallback_state (id, active, retry_count, probing, updated_at)
      VALUES (1, 0, 0, 0, datetime('now'));
    `);
  },
};
