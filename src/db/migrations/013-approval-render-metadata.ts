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

/** Add a column only if it doesn't already exist (idempotent re-run safety). */
function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export const migration013: Migration = {
  version: 13,
  name: 'approval-render-metadata',
  up(db: Database.Database) {
    // Guarded ALTERs: bare ADD COLUMN throws "duplicate column" if a target
    // column ever pre-exists (restored/merged DB, module touching these tables),
    // which would abort startup since migrations run in a transaction. Mirror
    // the moduleApprovalsTitleOptions guard pattern.
    addColumnIfMissing(db, 'pending_channel_approvals', 'title', `title TEXT NOT NULL DEFAULT ''`);
    addColumnIfMissing(db, 'pending_channel_approvals', 'options_json', `options_json TEXT NOT NULL DEFAULT '[]'`);
    addColumnIfMissing(db, 'pending_sender_approvals', 'title', `title TEXT NOT NULL DEFAULT ''`);
    addColumnIfMissing(db, 'pending_sender_approvals', 'options_json', `options_json TEXT NOT NULL DEFAULT '[]'`);
  },
};
