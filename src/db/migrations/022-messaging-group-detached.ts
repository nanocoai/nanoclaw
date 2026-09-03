import type { Migration } from './index.js';

/**
 * Detached marker on `messaging_groups`.
 *
 * Set (ISO timestamp) when our own bot LEFT the channel this row maps to —
 * the wiring survives, but delivery attempts are pointless until the bot is
 * re-invited. Cleared (NULL) when the bot rejoins (written by a channel
 * membership module). Deliberately not a delete: history, wirings, and
 * destinations all keep their rows so a rejoin restores the room with zero
 * re-setup.
 *
 * No backfill: existing rows stay NULL (= attached), reproducing pre-migration
 * behavior exactly.
 */
export const migration022: Migration = {
  version: 22,
  name: 'messaging-group-detached-at',
  async up(db) {
    await db.exec(`ALTER TABLE messaging_groups ADD COLUMN detached_at TEXT;`);
  },
};
