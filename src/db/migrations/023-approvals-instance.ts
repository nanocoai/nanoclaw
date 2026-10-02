import type { Migration } from './index.js';

/**
 * `instance` on `pending_approvals`: the adapter instance the card was
 * delivered through.
 *
 * The row already records `(channel_type, platform_id)` — where the card
 * went — but not which bot identity put it there. Delivery dispatch resolves
 * EXACT-key (`getChannelAdapterExact(instance ?? channelType)` in
 * channel-registry.ts) with no channelType fallback, so an install whose bots
 * are all named instances has nothing registered under the bare channel type
 * and any follow-up edit to the card resolves no adapter at all.
 *
 * NULL means "no instance recorded" and reads as the default instance
 * (= channel_type), which is what a single-instance install has anyway. No
 * backfill: `sweepStaleApprovals` clears every pending row on boot, so rows
 * predating this column never survive to be read.
 */
export const migration023: Migration = {
  version: 23,
  name: 'approvals-instance',
  async up(db) {
    await db.exec(`ALTER TABLE pending_approvals ADD COLUMN instance TEXT;`);
  },
};
