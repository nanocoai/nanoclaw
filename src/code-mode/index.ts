/** Register per-group code-mode and permission settings, plus the approval lifecycle. */
import type { DbDriver } from '../db/driver.js';
import { onDeliveryAdapterReady } from '../delivery.js';
import { onHostShutdown } from '../host-lifecycle.js';
import { startCodeBoundaryWatcher, stopCodeBoundaryWatcher } from '../modules/approvals/code-boundary.js';
import { registerMigration } from '../db/migrations/index.js';
// The remote terminal door registers its own host lifecycle hooks.
import './door/index.js';
// The chat surface for a coding session: its own table migration (a new
// table, independent of the columns below) and the host lifecycle of the
// mirror behind every bound sandbox. Imports are hoisted, so it registers
// first; nothing here depends on the order.
import './session-channel/index.js';

registerMigration({
  version: 1,
  name: 'module:code-mode:group-flag',
  async up(db: DbDriver) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN code_mode BIGINT NOT NULL DEFAULT 0`);
  },
});

registerMigration({
  version: 2,
  name: 'module:code-mode:permission-mode',
  async up(db: DbDriver) {
    // per-group permission posture. NULL = follow the deployment
    // default (NANOCLAW_CODE_PERMISSION_MODE); 'auto' | 'bypass' override it.
    // TEXT with no CHECK, matching cli_scope's precedent — the ncl write path
    // validates, and configFromDb reads anything unrecognized as absent.
    await db.exec(`ALTER TABLE container_configs ADD COLUMN permission_mode TEXT`);
  },
});

/** Detached boundary confirmation follows the Host delivery lifecycle. */
onDeliveryAdapterReady((adapter) => {
  startCodeBoundaryWatcher(adapter);
});

onHostShutdown(() => {
  stopCodeBoundaryWatcher();
});
