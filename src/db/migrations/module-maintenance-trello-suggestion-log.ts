import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Append-only history of destination-based Trello suggestions actually
 * shown to a worker -- what card ids, for which resolved property (or raw
 * destination text, when nothing matched), and when. Never rewritten; a
 * new row per suggestion event. This is what lets the agent tell "already
 * told them, nothing's changed" apart from "something new is worth
 * mentioning again" without relying on its own in-conversation memory
 * (which doesn't survive a container respawn).
 *
 * Old commit 824318ff shipped this as two sequential migrations: an
 * original NOT-NULL-FK-bound `property_id` shape, then a follow-up
 * recreating the table with a nullable `property_id` + new
 * `destination_key` dedup column once the raw-text Trello fallback (see
 * ../../modules/maintenance-worker-actions/trello-suggestion-log.ts)
 * showed the original FK made every unresolved-destination suggestion
 * impossible to record. This is a fresh registerMigration()-based
 * install with no existing rows to carry forward, so both steps collapse
 * into one migration in the final shape directly -- no backfill needed.
 */
export const moduleMaintenanceTrelloSuggestionLog: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:trello-suggestion-log',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE trello_suggestion_log (
        id               TEXT PRIMARY KEY,
        worker_user_id   TEXT NOT NULL,
        property_id      TEXT REFERENCES properties(id),
        destination_key  TEXT NOT NULL,
        card_ids         TEXT NOT NULL,
        shown_at         TEXT NOT NULL
      );
      CREATE INDEX idx_trello_suggestion_log_worker_destination ON trello_suggestion_log(worker_user_id, destination_key, shown_at);
      CREATE INDEX idx_trello_suggestion_log_property ON trello_suggestion_log(property_id);
    `);
  },
};
