/**
 * Persist the original card body for every approval-backed ask_question row.
 *
 * Terminal card edits need the body after the initial delivery (including
 * after a host restart). Existing rows get an empty body and retain the old
 * title-only fallback when they resolve.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'approval-question-render-metadata',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE pending_channel_approvals ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE pending_sender_approvals ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
  },
};
