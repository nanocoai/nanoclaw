import type { Migration } from './index.js';

/** NULL follows the deployment profile; otherwise runtime is an Agent Group property. */
export const migration025: Migration = {
  version: 25,
  name: 'container-config-runtime-tier',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN runtime_tier TEXT CHECK (runtime_tier IN ('container', 'vm'));`);
  },
};
