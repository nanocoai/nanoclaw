import type { Migration } from './index.js';

/** Opt-in per-group terminal-only delivery. NULL preserves existing behavior. */
export const migration025: Migration = {
  version: 25,
  name: 'container-config-response-delivery-mode',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN response_delivery_mode TEXT;`);
  },
};
