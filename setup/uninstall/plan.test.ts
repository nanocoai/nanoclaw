import { describe, it, expect } from 'vitest';

import type { VaultAgent } from './onecli-agents.js';
import { buildRemovalPlan, type Decisions, type RemovalAction } from './plan.js';
import type { Inventory, PathItem } from './scan.js';

const item = (p: string, what: string): PathItem => ({ what, where: p, path: p });

const agent = (uuid: string, identifier: string): VaultAgent => ({
  uuid,
  identifier,
  name: identifier,
});

function inventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    slug: 'abcd1234',
    projectRoot: '/proj',
    containerRuntime: 'docker',
    service: {
      launchdPlist: '/home/u/Library/LaunchAgents/com.nanoclaw-v2-abcd1234.plist',
      containerIds: ['c1', 'c2'],
      image: 'nanoclaw-agent-v2-abcd1234:latest',
      nclSymlink: '/home/u/.local/bin/ncl',
    },
    data: [
      item('/proj/data', 'Database & conversations'),
      item('/proj/logs', 'Logs'),
      item('/proj/.env', 'Secrets / API keys (.env)'),
      item('/proj/start-nanoclaw.sh', 'Start script'),
    ],
    runtime: [
      // node_modules deliberately FIRST — the planner must still order it last.
      item('/proj/node_modules', 'Installed dependencies'),
      item('/proj/dist', 'Build output'),
    ],
    user: [item('/proj/groups', 'Agent memory & files'), item('/proj/store', 'Migrated data store')],
    onecli: { mine: [], orphans: [], idsKnown: true },
    notes: [],
    ...overrides,
  };
}

const allYes = (onecliDelete: VaultAgent[] = []): Decisions => ({
  service: true,
  data: true,
  user: true,
  onecliDelete,
});

const kinds = (actions: RemovalAction[]) => actions.map((a) => a.kind);

describe('buildRemovalPlan ordering invariants', () => {
  it('removes .env only via the atomic backup action, never a bare delete', () => {
    const actions = buildRemovalPlan(inventory(), allYes());
    expect(actions.filter((a) => a.kind === 'backup-env')).toHaveLength(1);
    expect(
      actions.some((a) => a.kind === 'delete-path' && a.item.path === '/proj/.env'),
    ).toBe(false);
  });

  it('puts the runtime tail strictly last, with node_modules final', () => {
    const actions = buildRemovalPlan(inventory(), allYes([agent('u-1', 'ag-mine')]));
    const tail = actions.slice(-2);
    expect(tail.map((a) => a.kind)).toEqual(['delete-runtime-path', 'delete-runtime-path']);
    expect(tail.map((a) => (a.kind === 'delete-runtime-path' ? a.item.path : ''))).toEqual([
      '/proj/dist',
      '/proj/node_modules',
    ]);
    // No non-tail action after the first runtime delete.
    const firstTailIdx = actions.findIndex((a) => a.kind === 'delete-runtime-path');
    expect(
      actions.slice(firstTailIdx).every((a) => a.kind === 'delete-runtime-path'),
    ).toBe(true);
  });

  it('deletes OneCLI agents before the data group (which removes data/v2.db)', () => {
    const actions = buildRemovalPlan(inventory(), allYes([agent('u-1', 'ag-mine')]));
    const onecliIdx = actions.findIndex((a) => a.kind === 'delete-onecli-agent');
    const dataIdx = actions.findIndex(
      (a) => a.kind === 'delete-path' && a.item.path === '/proj/data',
    );
    expect(onecliIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeGreaterThan(onecliIdx);
  });

  it('runs service teardown before container removal so the host cannot respawn them', () => {
    const actions = buildRemovalPlan(inventory(), allYes());
    const unloadIdx = actions.findIndex((a) => a.kind === 'unload-service');
    const pkillIdx = actions.findIndex((a) => a.kind === 'pkill-host');
    const rmContainersIdx = actions.findIndex((a) => a.kind === 'rm-containers');
    expect(unloadIdx).toBeLessThan(rmContainersIdx);
    expect(pkillIdx).toBeLessThan(rmContainersIdx);
  });
});

describe('buildRemovalPlan declined groups', () => {
  it('declined data yields no data deletes and no runtime tail', () => {
    const actions = buildRemovalPlan(inventory(), {
      service: true,
      data: false,
      user: true,
      onecliDelete: [],
    });
    expect(kinds(actions)).not.toContain('backup-env');
    expect(kinds(actions)).not.toContain('delete-runtime-path');
    expect(
      actions.some((a) => a.kind === 'delete-path' && a.item.path.startsWith('/proj/data')),
    ).toBe(false);
  });

  it('all declined yields an empty plan', () => {
    const actions = buildRemovalPlan(inventory(), {
      service: false,
      data: false,
      user: false,
      onecliDelete: [],
    });
    expect(actions).toEqual([]);
  });

  it('declined service yields no service actions', () => {
    const actions = buildRemovalPlan(inventory(), {
      service: false,
      data: true,
      user: false,
      onecliDelete: [],
    });
    for (const kind of ['unload-service', 'pkill-host', 'rm-containers', 'rmi', 'rm-ncl-symlink']) {
      expect(kinds(actions)).not.toContain(kind);
    }
  });
});

describe('buildRemovalPlan conditional actions', () => {
  it('skips backup-env when there is no .env', () => {
    const inv = inventory({ data: [item('/proj/data', 'Database & conversations')] });
    expect(kinds(buildRemovalPlan(inv, allYes()))).not.toContain('backup-env');
  });

  it('always re-sweeps containers and processes with a confirmed service group', () => {
    const inv = inventory({ service: { containerIds: [] } });
    const actions = buildRemovalPlan(inv, allYes());
    const actionKinds = kinds(actions);
    expect(actionKinds).not.toContain('rmi');
    expect(actionKinds).not.toContain('unload-service');
    // pkill and rm-containers run unconditionally — a manually started host
    // has no plist/unit, and the live host may have spawned containers the
    // scan never saw. Removal re-lists by install label, not scan-time ids.
    expect(actionKinds).toContain('pkill-host');
    const rm = actions.find((a) => a.kind === 'rm-containers');
    expect(rm && rm.kind === 'rm-containers' ? rm.labelFilter : '').toBe(
      'nanoclaw-install=abcd1234',
    );
  });
});
