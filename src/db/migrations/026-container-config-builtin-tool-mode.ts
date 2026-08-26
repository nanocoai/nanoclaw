import type { Migration } from './index.js';

/** Opt-in provider-neutral removal of provider-native execution/network tools. */
export const migration026: Migration = {
  version: 26,
  name: 'container-config-builtin-tool-mode',
  sqliteOnly: true,
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN builtin_tool_mode TEXT;`);
  },
};
