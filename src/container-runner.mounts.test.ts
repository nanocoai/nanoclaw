import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// These are module-level consts in production; point them at a per-run temp
// tree via getters, so nothing here collides with a parallel test worker or
// with leftovers from an earlier run. Same shape as
// src/modules/mount-security/index.test.ts.
const mockState = vi.hoisted(() => ({ root: '' }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  get DATA_DIR() {
    return path.join(mockState.root, 'data');
  },
  get GROUPS_DIR() {
    return path.join(mockState.root, 'groups');
  },
  get MOUNT_ALLOWLIST_PATH() {
    return path.join(mockState.root, 'mount-allowlist.json');
  },
}));

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { buildMounts, volumeMountArgs } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initGroupFilesystem } from './group-init.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';
import type { VolumeMount } from './providers/provider-container-registry.js';

// A host directory that really exists: validateMount resolves the realPath, so
// a fictional path fails for a reason unrelated to what these tests are about.
let MOUNTED_DIR: string;

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function session(id: string, agentGroupId: string): Session {
  return { id, agent_group_id: agentGroupId, messaging_group_id: 'mg-1', thread_id: null } as Session;
}

function containerConfig(overrides: Partial<ContainerConfig> = {}): ContainerConfig {
  return { skills: [], mcpServers: {}, ...overrides } as ContainerConfig;
}

beforeAll(() => {
  mockState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mounts-'));
  MOUNTED_DIR = path.join(mockState.root, 'host', 'creds');
  fs.mkdirSync(MOUNTED_DIR, { recursive: true });
  fs.mkdirSync(path.join(mockState.root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(mockState.root, 'groups'), { recursive: true });
  // Permissive on purpose. These tests are about what buildMounts does with a
  // mount the allowlist permits; the allowlist's own rules are covered in
  // src/modules/mount-security/. realpath because the root is compared against
  // the resolved host path.
  fs.writeFileSync(
    path.join(mockState.root, 'mount-allowlist.json'),
    JSON.stringify({
      allowedRoots: [{ path: fs.realpathSync(mockState.root), allowReadWrite: true }],
      blockedPatterns: [],
    }),
  );
  runMigrations(initTestDb());
});

afterAll(() => {
  closeDb();
  fs.rmSync(mockState.root, { recursive: true, force: true });
});

describe('volumeMountArgs', () => {
  it('marks a read-only mount :ro', () => {
    expect(volumeMountArgs([{ hostPath: '/h/a', containerPath: '/c/a', readonly: true }])).toEqual([
      '-v',
      '/h/a:/c/a:ro',
    ]);
  });

  it('leaves a read-write mount writable', () => {
    // The half the pipeline had no coverage for. `add-mount` without --ro, an
    // allowlist root with allowReadWrite, and a stored `readonly: false` all
    // amount to nothing if this branch appends :ro anyway.
    expect(volumeMountArgs([{ hostPath: '/h/b', containerPath: '/c/b', readonly: false }])).toEqual([
      '-v',
      '/h/b:/c/b',
    ]);
  });

  it('treats an absent readonly flag as read-write', () => {
    // Provider contributions and v1-migrated configs both produce entries with
    // no `readonly` key. Docker's default for a bind is read-write, and this
    // has always matched it — pinned so it stays a deliberate choice.
    expect(volumeMountArgs([{ hostPath: '/h/c', containerPath: '/c/c' } as VolumeMount])).toEqual(['-v', '/h/c:/c/c']);
  });

  it('emits one pair per mount, in order', () => {
    // Order is load-bearing: docker applies binds in argument order, so a mount
    // nested inside another has to stay after its parent or it is shadowed.
    expect(
      volumeMountArgs([
        { hostPath: '/h/parent', containerPath: '/c/parent', readonly: false },
        { hostPath: '/h/child', containerPath: '/c/parent/child', readonly: true },
      ]),
    ).toEqual(['-v', '/h/parent:/c/parent', '-v', '/h/child:/c/parent/child:ro']);
  });

  it('returns nothing for no mounts', () => {
    expect(volumeMountArgs([])).toEqual([]);
  });
});

describe('buildMounts additional mounts', () => {
  function mountsFor(id: string, additionalMounts: ContainerConfig['additionalMounts']): VolumeMount[] {
    const ag = group(id, id);
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});
    return buildMounts(ag, session(`s-${id}`, ag.id), containerConfig({ additionalMounts }), 'claude', {});
  }

  it('carries a read-write additional mount through to a writable bind', () => {
    // End to end for the defect this branch fixes: `readonly: false` on the
    // config row has to survive validation and arrive as a bind with no :ro.
    const mounts = mountsFor('ag-mounts-rw', [{ hostPath: MOUNTED_DIR, containerPath: 'creds', readonly: false }]);

    const mount = mounts.find((m) => m.containerPath === '/workspace/extra/creds');
    expect(mount).toBeDefined();
    expect(mount!.readonly).toBe(false);
    expect(volumeMountArgs([mount!])).toEqual(['-v', `${MOUNTED_DIR}:/workspace/extra/creds`]);
  });

  it('carries a read-only additional mount through to a :ro bind', () => {
    const mounts = mountsFor('ag-mounts-ro', [{ hostPath: MOUNTED_DIR, containerPath: 'creds', readonly: true }]);

    const mount = mounts.find((m) => m.containerPath === '/workspace/extra/creds');
    expect(mount).toBeDefined();
    expect(mount!.readonly).toBe(true);
    expect(volumeMountArgs([mount!])).toEqual(['-v', `${MOUNTED_DIR}:/workspace/extra/creds:ro`]);
  });

  it('drops a mount the allowlist does not cover rather than mounting it', () => {
    const mounts = mountsFor('ag-mounts-outside', [{ hostPath: '/etc', containerPath: 'etc', readonly: true }]);

    expect(mounts.map((m) => m.containerPath)).not.toContain('/workspace/extra/etc');
  });
});
