import type { Migration } from './index.js';

/**
 * Persist the question body of every ask_user_question card, like migration
 * 021 did for approval cards, so the card keeps it when someone answers.
 * Existing rows get an empty body and keep the old title-only edit.
 */
export const migration026: Migration = {
  version: 26,
  name: 'pending-question-body',
  async up(db) {
    await db.exec(`ALTER TABLE pending_questions ADD COLUMN question TEXT NOT NULL DEFAULT ''`);
  },
};
