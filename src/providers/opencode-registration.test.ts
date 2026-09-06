/**
 * Integration test for the opencode provider's HOST-side reach-in: the self-registration
 * import in the src/providers/index.ts barrel. Importing the barrel runs opencode.ts's
 * top-level registerProviderContainerConfig('opencode', …); without that import line the
 * host never wires the provider's per-session mounts / env passthrough.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./opencode.js directly, then asserts the registry actually contains the provider.
 * Importing the provider module directly (as opencode.factory.test.ts does) self-registers
 * it and would stay GREEN even if the barrel line were deleted — that is a unit test,
 * not a registration guard. This test goes red if the barrel import is deleted/drifts,
 * or the barrel fails to evaluate.
 *
 * A provider is a MULTI-POINT integration: this guards the HOST barrel; the CONTAINER
 * barrel is guarded by the sibling bun test; the SDK/CLI dependency + Dockerfile install
 * are guarded by the build/container legs (see the skill's validate step).
 *
 * The contribution tests below drive the REAL registered adapter against the real
 * buildMounts on either core generation: on a pre-contract core the adapter creates and
 * mounts the per-session XDG directory itself; on the contract core it hands over only
 * env and core realizes the declared surfaces — the same paths, once.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-opencode-host-contribution-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const newCoreIt = fs.existsSync(path.join(process.cwd(), 'src/provider-contracts/realize.ts')) ? it : it.skip;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-opencode-host-contribution-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-opencode-host-contribution-test/groups',
}));

import { buildMounts } from '../container-runner.js';
import type { ContainerConfig } from '../container-config.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import { initGroupFilesystem } from '../group-init.js';
import type { AgentGroup, Session } from '../types.js';
import { getProviderContainerConfig, listProviderContainerConfigNames } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel — triggers each provider's self-registration

function group(): AgentGroup {
  return {
    id: 'ag-opencode',
    name: 'OpenCode',
    folder: 'opencode-group',
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as AgentGroup;
}

const CONFIG: ContainerConfig = {
  provider: 'opencode',
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
};

const SURFACE_PATHS = ['/workspace/agent/CLAUDE.md', '/home/node/.claude', '/opencode-xdg'];

describe('opencode provider host registration', () => {
  beforeEach(async () => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('registers opencode host container-config via the barrel', () => {
    expect(listProviderContainerConfigNames()).toContain('opencode');
  });

  it('creates and mounts the XDG dir itself, unless core says it owns the surfaces', async () => {
    const adapter = getProviderContainerConfig('opencode')!;
    const sessionDir = path.join(DATA_DIR, 'v2-sessions', 'group-1', 'session-1');
    const base = {
      sessionDir,
      agentGroupId: 'group-1',
      groupDir: path.join(GROUPS_DIR, 'group'),
      selectedSkills: [],
      hostEnv: {},
    };

    const legacy = await adapter(base);
    expect(legacy.mounts).toEqual([
      { hostPath: path.join(sessionDir, 'opencode-xdg'), containerPath: '/opencode-xdg', readonly: false },
    ]);
    expect(fs.existsSync(path.join(sessionDir, 'opencode-xdg'))).toBe(true);
    expect(legacy.env).toMatchObject({ XDG_DATA_HOME: '/opencode-xdg' });

    fs.rmSync(sessionDir, { recursive: true, force: true });
    // Built as a variable, not an inline literal: a pre-contract core's context
    // type has no coreOwnsProviderSurfaces member, and this file compiles there too.
    const declaredContext = { ...base, coreOwnsProviderSurfaces: true as const };
    const declared = await adapter(declaredContext);
    expect(declared.mounts).toEqual([]);
    expect(declared.env).toEqual(legacy.env);
    expect(fs.existsSync(path.join(sessionDir, 'opencode-xdg'))).toBe(false);
  });

  newCoreIt('lets the contract core realize the Claude document plane plus the XDG volume', async () => {
    const ag = group();
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const session = { id: 'session-1', agent_group_id: ag.id } as Session;
    const sessionDir = path.join(DATA_DIR, 'v2-sessions', ag.id, session.id);
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id, 'opencode');
    await initGroupFilesystem(ag, { provider: 'opencode' });

    // What resolveProviderContribution hands the adapter on a contract core.
    const declaredContext = {
      sessionDir,
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: [],
      hostEnv: {},
      coreOwnsProviderSurfaces: true as const,
    };
    const contribution = await getProviderContainerConfig('opencode')!(declaredContext);
    expect(contribution.mounts ?? []).toEqual([]);
    expect(fs.existsSync(path.join(sessionDir, 'opencode-xdg'))).toBe(false);

    const mounts = await buildMounts(ag, session, CONFIG, 'opencode', contribution);

    expect(
      mounts
        .filter((mount) => SURFACE_PATHS.includes(mount.containerPath))
        .map(({ containerPath, hostPath, readonly }) => ({ containerPath, hostPath, readonly })),
    ).toEqual([
      { containerPath: '/workspace/agent/CLAUDE.md', hostPath: path.join(groupDir, 'CLAUDE.md'), readonly: true },
      {
        containerPath: '/home/node/.claude',
        hostPath: path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared'),
        readonly: false,
      },
      { containerPath: '/opencode-xdg', hostPath: path.join(sessionDir, 'opencode-xdg'), readonly: false },
    ]);
    // Core created the volume the adapter no longer creates.
    expect(fs.existsSync(path.join(sessionDir, 'opencode-xdg'))).toBe(true);
    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json'))).toBe(true);
    expect(contribution.env).toMatchObject({
      XDG_DATA_HOME: '/opencode-xdg',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    });
  });
});
