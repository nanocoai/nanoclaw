import { describe, expect, it } from 'vitest';

import { sameOwnershipSelectors, uninstallIncomplete, uninstallSelectionError } from './flow.js';
import type { Inventory } from './scan.js';

function inventory(onecliAvailable = true): Pick<Inventory, 'onecli'> {
  return {
    onecli: {
      mine: [],
      orphans: [],
      available: onecliAvailable,
      idsKnown: true,
    },
  };
}

describe('terminal uninstall safety gates', () => {
  it('rejects destructive choices that preserve the service', () => {
    expect(
      uninstallSelectionError(inventory(), {
        service: false,
        data: true,
        user: false,
      }),
    ).toMatch(/cannot be removed/);
  });

  it('preserves app data when OneCLI inventory is unavailable', () => {
    expect(
      uninstallSelectionError(inventory(false), {
        service: true,
        data: true,
        user: true,
      }),
    ).toMatch(/Restore OneCLI/);
  });

  it('reports failed or untouched actions as incomplete', () => {
    expect(uninstallIncomplete([{ outcome: 'removed' }])).toBe(false);
    expect(uninstallIncomplete([{ outcome: 'failed' }])).toBe(true);
    expect(uninstallIncomplete([{ outcome: 'untouched' }])).toBe(true);
  });

  it('rejects a checkout root replaced after approval', () => {
    const base: Inventory = {
      slug: 'abcd1234',
      projectRoot: '/tmp/nanoclaw',
      containerRuntime: 'docker',
      service: { containerIds: [] },
      data: [],
      runtime: [],
      user: [],
      envBackups: [],
      onecli: inventory().onecli,
      notes: [],
      identity: {
        root: 'node:1:2:16832',
        exactPaths: {},
        scopedRoots: {},
        containerSelector: 'nanoclaw-install=abcd1234',
      },
    };

    expect(sameOwnershipSelectors(base, structuredClone(base))).toBe(true);
    const replaced = structuredClone(base);
    replaced.identity!.root = 'node:1:3:16832';
    expect(sameOwnershipSelectors(base, replaced)).toBe(false);
  });

  it('leaves artifact identity changes to each removal action', () => {
    const base: Inventory = {
      slug: 'abcd1234',
      projectRoot: '/tmp/nanoclaw',
      containerRuntime: 'docker',
      service: { containerIds: [] },
      data: [],
      runtime: [],
      user: [],
      envBackups: [],
      onecli: inventory().onecli,
      notes: [],
      identity: {
        root: 'node:1:2:16832',
        exactPaths: { '/tmp/nanoclaw/logs': 'node:1:3:16832' },
        scopedRoots: {},
        containerSelector: 'nanoclaw-install=abcd1234',
      },
    };
    const changed = structuredClone(base);
    changed.identity!.exactPaths['/tmp/nanoclaw/logs'] = 'node:1:4:16832';

    expect(sameOwnershipSelectors(base, changed)).toBe(true);
  });

  it('rejects a scoped root swapped after approval unless only selectors are compared', () => {
    const base: Inventory = {
      slug: 'abcd1234',
      projectRoot: '/tmp/nanoclaw',
      containerRuntime: 'docker',
      service: { containerIds: [] },
      data: [],
      runtime: [],
      user: [],
      envBackups: [],
      onecli: inventory().onecli,
      notes: [],
      identity: {
        root: 'node:1:2:16832',
        exactPaths: {},
        scopedRoots: { '/tmp/nanoclaw/store': 'node:1:5:16832' },
        containerSelector: 'nanoclaw-install=abcd1234',
      },
    };
    const swapped = structuredClone(base);
    swapped.identity!.scopedRoots['/tmp/nanoclaw/store'] = 'node:1:6:16832';

    // Terminal uninstall: every selector still matches, so only the deep
    // scopedRoots comparison can catch a directory replaced after approval.
    expect(sameOwnershipSelectors(base, swapped)).toBe(false);
    // Machine rescan: it compares two scans of its own making, so it opts out
    // of the deep comparison and keeps going.
    expect(sameOwnershipSelectors(base, swapped, { selectorsOnly: true })).toBe(true);
  });
});
