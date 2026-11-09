/**
 * ensureContainerConfig provider stamping (global-default-provider feature).
 *
 * Two load-bearing guarantees:
 *   1. A fresh row is stamped with the given provider (claude → NULL), so a new
 *      group is created on the instance default.
 *   2. An existing row is never overwritten (INSERT OR IGNORE), so enabling a
 *      non-claude default never retroactively flips existing groups.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from './container-configs.js';

async function makeGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

describe('ensureContainerConfig provider stamping', () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
  });
  afterEach(async () => {
    await closeDb();
  });

  it('stamps a non-default provider on a fresh row; claude is stored as NULL', async () => {
    await makeGroup('ag-codex');
    await ensureContainerConfig('ag-codex', 'codex');
    expect((await getContainerConfig('ag-codex'))?.provider).toBe('codex');

    await makeGroup('ag-claude');
    await ensureContainerConfig('ag-claude', 'claude');
    expect((await getContainerConfig('ag-claude'))?.provider).toBeNull();

    // Casing is normalized to match what resolution lowercases to.
    await makeGroup('ag-cased');
    await ensureContainerConfig('ag-cased', 'Codex');
    expect((await getContainerConfig('ag-cased'))?.provider).toBe('codex');

    await makeGroup('ag-cased-claude');
    await ensureContainerConfig('ag-cased-claude', 'Claude');
    expect((await getContainerConfig('ag-cased-claude'))?.provider).toBeNull();
  });

  it('never overwrites an existing row — existing groups are not flipped', async () => {
    await makeGroup('ag-existing');
    await ensureContainerConfig('ag-existing', 'codex'); // existing group already on codex
    expect((await getContainerConfig('ag-existing'))?.provider).toBe('codex');

    // A later bare ensure (defensive re-init, or a changed instance default)
    // must NOT change it — INSERT OR IGNORE keeps the row frozen.
    await ensureContainerConfig('ag-existing');
    expect((await getContainerConfig('ag-existing'))?.provider).toBe('codex');
  });

  it('sets and clears the timezone override (NULL = follow the install default)', async () => {
    await makeGroup('ag-tz');
    await ensureContainerConfig('ag-tz');
    expect((await getContainerConfig('ag-tz'))?.timezone).toBeNull();

    await updateContainerConfigScalars('ag-tz', { timezone: 'Asia/Tokyo' });
    expect((await getContainerConfig('ag-tz'))?.timezone).toBe('Asia/Tokyo');

    // `ncl groups config update --timezone ""` maps to null — the clear path.
    await updateContainerConfigScalars('ag-tz', { timezone: null });
    expect((await getContainerConfig('ag-tz'))?.timezone).toBeNull();
  });
});
