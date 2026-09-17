import type { Migration } from './index.js';

/** Opt-in provider-neutral removal of provider-native execution/network tools. */
export const migration028: Migration = {
  version: 28,
  name: 'container-config-builtin-tool-mode',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN builtin_tool_mode TEXT;`);
  },
};
