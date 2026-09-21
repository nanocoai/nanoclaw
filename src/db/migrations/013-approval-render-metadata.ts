/**
 * Persist ask_question render metadata (title + options_json) on
 * `pending_channel_approvals` and `pending_sender_approvals`, mirroring the
 * columns migration 003 / module-approvals-title-options added to
 * `pending_approvals`.
 *
 * Before this, `getAskQuestionRender` hardcoded the title + option labels
 * for these two tables in the DB-access layer — duplicating wording that
 * also lived in the approval modules and causing a visible drift between
 * the initial card title ("📣 Bot mentioned in new chat" / "💬 New direct
 * message", chosen per event) and the post-click render ("📣 Channel
 * registration", constant). Storing the render metadata alongside the row
 * lets both sides read from the same source.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration013: Migration = {
  version: 13,
  name: 'approval-render-metadata',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`ALTER TABLE pending_channel_approvals ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE pending_channel_approvals ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'`);
    db.exec(`ALTER TABLE pending_sender_approvals ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE pending_sender_approvals ADD COLUMN options_json TEXT NOT NULL DEFAULT '[]'`);
  },
};
