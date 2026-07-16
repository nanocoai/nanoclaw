import type { Migration } from './index.js';

export const moduleFallbackEvents: Migration = {
  version: 22,
  name: 'fallback-events',
  up(db) {
    db.exec(`
      CREATE TABLE fallback_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
        event_type TEXT NOT NULL,
        reason     TEXT,
        details    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_fallback_events_ts ON fallback_events(timestamp);
    `);
  },
};
