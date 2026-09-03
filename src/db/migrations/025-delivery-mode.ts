import type { Migration } from './index.js';

/**
 * Per-group delivery contract on `container_configs`.
 *
 * NULL = the envelope contract: final-text `<message to="…">` blocks deliver
 * alongside the outbound tools. `'tools-only'` = only an explicit send tool
 * reaches a destination and everything else the agent writes is private.
 * Deliberately nullable with no default and no backfill: existing rows stay
 * NULL and resolve to the envelope contract, reproducing pre-migration
 * delivery exactly.
 */
export const migration025: Migration = {
  version: 25,
  name: 'delivery-mode',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN delivery_mode TEXT;`);
  },
};
