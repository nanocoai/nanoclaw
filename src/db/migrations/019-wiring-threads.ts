import type { Migration } from './index.js';

/**
 * Per-wiring thread-policy override on `messaging_group_agents`.
 *
 * NULL = inherit the channel adapter's declared default for the wiring's
 * context (DM vs group); 1/0 = explicit per-wiring override, hard-ANDed with
 * the adapter's raw thread capability at router fanout (resolveThreadPolicy
 * in src/channels/channel-defaults.ts). Deliberately no backfill: existing
 * rows stay NULL and resolve through the declaration — or, for undeclared
 * adapters, the behavior-faithful fallback whose threads value tracks
 * supportsThreads — reproducing pre-migration routing exactly.
 */
export const migration019: Migration = {
  version: 19,
  name: 'wiring-threads-override',
  up(db) {
    db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN threads INTEGER;`);
  },
};
