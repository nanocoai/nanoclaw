/**
 * Code mode — the group flag (sandbox-spec D13, D16, D22).
 *
 * Code mode is a per-agent-group property on `container_configs`, beside
 * `cli_scope` whose precedent it follows. Everything it changes happens at
 * spawn composition: the entrypoint selects the code runner instead of the
 * chat runner (D22 — same image, host-mounted source, spawn-time selection),
 * and chat composition is stripped while capabilities stay (D16). Flipping
 * the flag takes effect on respawn (D13) — `ncl groups restart` is already
 * that mechanism.
 *
 * The column arrives by module migration, not the trunk-synced barrel — the
 * same route the dev-env registry took. Core reads tolerate its absence
 * (an unmigrated row simply has no `code_mode` key, which reads as off).
 *
 * Both migrations are PORTABLE (`up(db: DbDriver)`), never `sqliteOnly`: a
 * deployment whose central DB is PostgreSQL refuses a SQLite-only migration
 * outright (`applyMigration` throws "port it or provide a backend migration
 * override"), and no backend baseline covers module migrations, so
 * `sqliteOnly` on a module is a skill that cannot deploy there at all. Both
 * columns are plain ANSI `ALTER TABLE … ADD COLUMN`, so one text serves both.
 *
 * `code_mode` stays an INTEGER-family column and is spelled BIGINT, matching
 * dev-env's house rule and the width the PostgreSQL baseline gives every
 * SQLite INTEGER. It must NOT become BOOLEAN: every reader is a strict
 * `row.code_mode === 1` and every writer binds 1/0, and the pg driver's param
 * sanitizer refuses a JS boolean by design. SQLite reads BIGINT as INTEGER
 * affinity and the pg driver parses int8 back to a JS number, so `=== 1`
 * holds on both.
 */
import type { DbDriver } from '../db/driver.js';
import { onDeliveryAdapterReady } from '../delivery.js';
import { onHostShutdown } from '../host-lifecycle.js';
import { startCodeBoundaryWatcher, stopCodeBoundaryWatcher } from '../modules/approvals/code-boundary.js';
import { registerMigration } from '../db/migrations/index.js';

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
    // D17/T7: per-group permission posture. NULL = follow the deployment
    // default (NANOCLAW_CODE_PERMISSION_MODE); 'auto' | 'bypass' override it.
    // TEXT with no CHECK, matching cli_scope's precedent — the ncl write path
    // validates, and configFromDb reads anything unrecognized as absent.
    await db.exec(`ALTER TABLE container_configs ADD COLUMN permission_mode TEXT`);
  },
});

/**
 * D17's detached confirm, on ITS OWN lifecycle callbacks.
 *
 * The watcher used to ride inside the approvals module's OneCLI
 * manual-approval callbacks, which it merely shares a trigger with. A
 * deployment whose approver is the Gateway replaces that client outright
 * (skills/nanoco-session-sidecar deletes those callback blocks), and the
 * composed result was a block calling deleted imports — green compose, red
 * compiler. Registering here couples the watcher to nothing but the host's
 * own lifecycle. Late registration is safe: onDeliveryAdapterReady fires an
 * already-set adapter immediately.
 */
onDeliveryAdapterReady((adapter) => {
  startCodeBoundaryWatcher(adapter);
});

onHostShutdown(() => {
  stopCodeBoundaryWatcher();
});
