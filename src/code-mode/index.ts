/**
 * Code mode — a group whose agent runs as an interactive coding session
 * (the code runner) instead of the chat loop.
 *
 * Registered here: the two container_configs columns the feature reads at
 * spawn, and the host half of the sandbox boundary confirm (it follows the
 * delivery lifecycle: cards need an adapter). Behaviour changes only for
 * groups whose config sets code_mode; every other group is untouched by
 * this import.
 */
import type { DbDriver } from '../db/driver.js';
import { registerMigration } from '../db/migrations/index.js';
import { onDeliveryAdapterReady } from '../delivery.js';
import { onHostShutdown } from '../host-lifecycle.js';
import { startCodeBoundaryWatcher, stopCodeBoundaryWatcher } from '../modules/approvals/code-boundary.js';

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
    // Per-group permission posture. NULL = follow the deployment default
    // (NANOCLAW_CODE_PERMISSION_MODE); 'auto' | 'bypass' override it.
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
