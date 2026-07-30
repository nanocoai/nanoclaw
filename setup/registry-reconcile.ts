/**
 * Step: registry-reconcile — drop per-agent-group derived images so every group
 * actually runs the image at the slug tag.
 *
 * `container-runner.ts` spawns `containerConfig.imageTag || CONTAINER_IMAGE`, so
 * any group that ran `install_packages` carries a pin to its own derived image
 * built `FROM <base>:latest` months ago. That pin wins, which means retagging
 * the slug tag onto newly pulled bytes does nothing for that group while verify
 * still reports the install as hardened — inverting the property being bought.
 * Clearing the pin costs the group its extra apt/npm packages; that is the trade.
 *
 * NOTE: nothing yet *disables* `install_packages` on the hardened path, so a
 * group can re-derive afterwards and drop off the hardened base again. This is a
 * one-shot correction, not an invariant.
 *
 * Idempotent — a second run finds nothing pinned and nothing to remove.
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import type DatabaseType from 'better-sqlite3';

import { CONTAINER_IMAGE_BASE, DATA_DIR } from '../src/config.js';
import { CONTAINER_RUNTIME_BIN } from '../src/container-runtime.js';
import { getAllContainerConfigs, updateContainerConfigScalars } from '../src/db/container-configs.js';
import { getDb, hasTable, initDb } from '../src/db/connection.js';
import { log } from '../src/log.js';
import { readImageSource } from './lib/registry-state.js';
import { emitStatus } from './status.js';

export interface ReconcileResult {
  /** Agent groups whose pin pointed at an image this install built. */
  cleared: string[];
  /** Derived image tags actually removed from the runtime. */
  removed: string[];
  /** Tags whose row we cleared but whose image is still on disk. */
  notRemoved: string[];
  /** Pins pointing somewhere we didn't build — left alone, reported. */
  foreign: { agentGroupId: string; imageTag: string }[];
}

function emptyResult(): ReconcileResult {
  return { cleared: [], removed: [], notRemoved: [], foreign: [] };
}

/**
 * Conservative shape for a tag we're willing to hand to `docker rmi`. The value
 * is already constrained (it has to equal a string we built ourselves), but an
 * argv element beginning with `-` would be read as a flag, so gate it the same
 * way `stopContainer` gates container names.
 */
const SAFE_IMAGE_REF = /^[a-zA-Z0-9][a-zA-Z0-9_.\-/]*:[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * Clear every derived-image pin and remove the images behind them.
 *
 * Unconditional by design so the pull path can call it immediately after a
 * retag without re-reading state. **Do not call it on the local build path** —
 * there a derived image is a working feature, not residue. The `run()` entry
 * point below carries that guard; a direct caller has to carry it itself.
 */
export function reconcileDerivedImages(): ReconcileResult {
  const result = emptyResult();

  const dbPath = path.join(DATA_DIR, 'v2.db');
  if (!fs.existsSync(dbPath)) {
    // First install: no central DB, so no group has ever built a derived
    // image. Bail before initDb, which would create an empty file here.
    log.info('No central DB — nothing to reconcile', { dbPath });
    return result;
  }

  // The step runs standalone (`--step registry-reconcile`) or is called from
  // the container step, which has no DB open. Reuse an existing handle rather
  // than opening a second writer onto the same file.
  let db: DatabaseType.Database;
  try {
    db = getDb();
  } catch {
    db = initDb(dbPath);
  }

  if (!hasTable(db, 'container_configs')) {
    // Migrations haven't run yet. Nothing can be pinned before the table exists.
    log.info('container_configs not present — nothing to reconcile');
    return result;
  }

  for (const row of getAllContainerConfigs()) {
    if (!row.image_tag) continue;

    const derivedTag = `${CONTAINER_IMAGE_BASE}:${row.agent_group_id}`;
    if (row.image_tag !== derivedTag) {
      // An operator-supplied image, not one buildAgentGroupImage produced.
      // Removing it would destroy something we never created, so report it and
      // leave it: the group won't run the pulled image, and that's the
      // operator's standing decision to revisit, not ours to overrule.
      result.foreign.push({ agentGroupId: row.agent_group_id, imageTag: row.image_tag });
      log.warn('Agent group pins a non-derived image — left in place', {
        agentGroupId: row.agent_group_id,
        imageTag: row.image_tag,
      });
      continue;
    }

    // Clear the pin BEFORE touching the runtime. The host re-reads this row at
    // every spawn, so the instant it is NULL the group is back on the slug tag
    // regardless of what the `docker rmi` below does. Doing it the other way
    // round would open a window where the row points at an image that no
    // longer exists, and the group would fail to spawn instead of downgrading.
    updateContainerConfigScalars(row.agent_group_id, { image_tag: null });
    result.cleared.push(row.agent_group_id);
    log.info('Cleared derived image pin', { agentGroupId: row.agent_group_id, imageTag: derivedTag });

    if (!SAFE_IMAGE_REF.test(derivedTag)) {
      result.notRemoved.push(derivedTag);
      continue;
    }
    // Not `-f`: a derived image still held by a running container should stay
    // until that container exits. The row is already clear, so the leftover is
    // inert — the next spawn uses the slug tag either way.
    const rmi = spawnSync(CONTAINER_RUNTIME_BIN, ['rmi', derivedTag], { encoding: 'utf-8' });
    const stderr = (rmi.stderr ?? '').trim();
    if (rmi.status === 0) {
      result.removed.push(derivedTag);
    } else if (/no such image/i.test(stderr)) {
      // The pin outlived its image — a pruned or manually removed build. The
      // group was already failing to spawn; clearing the row is the whole fix,
      // so this is normal housekeeping, not a warning.
      log.info('Derived image already absent', { imageTag: derivedTag });
    } else {
      result.notRemoved.push(derivedTag);
      log.warn('Could not remove derived image — pin is cleared, image left behind', {
        imageTag: derivedTag,
        stderr,
      });
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const source = readImageSource();

  // On the local build path a derived image is a live capability, so the
  // default is a no-op. `--force` exists for the operator who wants the pins
  // dropped without switching image source (e.g. after a manual `docker load`).
  if (source !== 'hardened' && !force) {
    log.info('Image source is local — skipping reconcile', { source });
    emitStatus('REGISTRY_RECONCILE', {
      IMAGE_SOURCE: source,
      SKIPPED: 'local_image_source',
      CLEARED: 0,
      IMAGES_REMOVED: 0,
      IMAGES_NOT_REMOVED: 0,
      FOREIGN_PINS: 0,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  const result = reconcileDerivedImages();

  log.info('Reconcile complete', {
    cleared: result.cleared.length,
    removed: result.removed.length,
    notRemoved: result.notRemoved.length,
    foreign: result.foreign.length,
  });

  emitStatus('REGISTRY_RECONCILE', {
    IMAGE_SOURCE: source,
    CLEARED: result.cleared.length,
    IMAGES_REMOVED: result.removed.length,
    IMAGES_NOT_REMOVED: result.notRemoved.length,
    FOREIGN_PINS: result.foreign.length,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
