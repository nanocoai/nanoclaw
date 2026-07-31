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

function makeGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

describe('ensureContainerConfig provider stamping', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });
  afterEach(() => {
    closeDb();
  });

  it('stamps a non-default provider on a fresh row; claude is stored as NULL', () => {
    makeGroup('ag-codex');
    ensureContainerConfig('ag-codex', 'codex');
    expect(getContainerConfig('ag-codex')?.provider).toBe('codex');

    makeGroup('ag-claude');
    ensureContainerConfig('ag-claude', 'claude');
    expect(getContainerConfig('ag-claude')?.provider).toBeNull();

    // Casing is normalized to match what resolution lowercases to.
    makeGroup('ag-cased');
    ensureContainerConfig('ag-cased', 'Codex');
    expect(getContainerConfig('ag-cased')?.provider).toBe('codex');

    makeGroup('ag-cased-claude');
    ensureContainerConfig('ag-cased-claude', 'Claude');
    expect(getContainerConfig('ag-cased-claude')?.provider).toBeNull();
  });

  it('never overwrites an existing row — existing groups are not flipped', () => {
    makeGroup('ag-existing');
    ensureContainerConfig('ag-existing', 'codex'); // existing group already on codex
    expect(getContainerConfig('ag-existing')?.provider).toBe('codex');

    // A later bare ensure (defensive re-init, or a changed instance default)
    // must NOT change it — INSERT OR IGNORE keeps the row frozen.
    ensureContainerConfig('ag-existing');
    expect(getContainerConfig('ag-existing')?.provider).toBe('codex');
  });

  it('sets and clears the timezone override (NULL = follow the install default)', () => {
    makeGroup('ag-tz');
    ensureContainerConfig('ag-tz');
    expect(getContainerConfig('ag-tz')?.timezone).toBeNull();

    updateContainerConfigScalars('ag-tz', { timezone: 'Asia/Tokyo' });
    expect(getContainerConfig('ag-tz')?.timezone).toBe('Asia/Tokyo');

    // `ncl groups config update --timezone ""` maps to null — the clear path.
    updateContainerConfigScalars('ag-tz', { timezone: null });
    expect(getContainerConfig('ag-tz')?.timezone).toBeNull();
  });
});
