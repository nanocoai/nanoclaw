import type { Migration } from './index.js';

/**
 * Per-agent-group `speed` on `container_configs`.
 *
 * NULL = the install/provider default — deliberately no backfill. Providers
 * map `speed: "standard" | "fast"` onto their native serving tier.
 */
export const migration025: Migration = {
  version: 25,
  name: 'container-config-speed',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN speed TEXT;`);
  },
};
