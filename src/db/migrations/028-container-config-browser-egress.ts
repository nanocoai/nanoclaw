import type { Migration } from './index.js';

/**
 * Per-agent-group opt-in to direct browser egress on `container_configs`.
 *
 * 0 (the default, and what every existing row gets — deliberately no backfill)
 * means today's behavior exactly: the container reaches the internet only
 * through the OneCLI gateway on the `--internal` egress network.
 *
 * 1 means the group's containers additionally attach to a non-internal bridge
 * network and launch `agent-browser` with the proxy variables stripped, so
 * browser traffic bypasses the gateway's credential injection and audit trail
 * entirely. That is a real loosening of one container's sandbox — see
 * `src/browser-direct-egress.ts` and docs/SECURITY.md §7. The column is INTEGER
 * NOT NULL DEFAULT 0 so "absent" and "off" cannot diverge, and the reader
 * (`configFromDb`) treats anything that is not exactly 1 as off: a
 * hand-corrupted value must fail toward the perimeter, never away from it.
 */
export const migration028: Migration = {
  version: 28,
  name: 'container-config-browser-egress',
  sqliteOnly: true,
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN direct_browser_egress INTEGER NOT NULL DEFAULT 0;`);
  },
};
