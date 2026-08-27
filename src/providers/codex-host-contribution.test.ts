/**
 * In-process seam test for the codex HOST contribution's runtime consumption
 * of core (the "consumes core" leg the skill guidelines require): drive the
 * REAL registered contribution — via the real barrel and registry, never by
 * importing codex.ts's internals — against a real test DB and a temp
 * GROUPS_DIR/DATA_DIR, then hand its result to the real buildMounts.
 *
 * This is what catches core drift that typecheck can't: the
 * DATA_DIR/v2-sessions/<id>/.codex-shared session layout, the
 * getAgentGroup/getContainerConfig reads, the mcp_servers JSON shape consumed
 * by composeGroupAgentsMd, and the mount set buildMounts assembles for a
 * surfaces-providing provider. (codex-registration.test.ts only guards that
 * the name is registered; provider-surfaces.test.ts drives a FAKE provider to
 * test the seam itself.)
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-codex-host-contribution-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const newCoreIt = fs.existsSync(path.join(process.cwd(), 'src/provider-contracts/realize.ts')) ? it : it.skip;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-codex-host-contribution-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-codex-host-contribution-test/groups',
}));

import { buildMounts } from '../container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

type MountShape = { containerPath: string; hostPath: string; readonly: boolean };

const CODEX_CONTAINER_PATHS = [
  '/home/node/.codex',
  '/workspace/agent/AGENTS.md',
  '/workspace/agent/.agents',
  '/home/node/.agents',
];

function codexMounts(mounts: readonly MountShape[]): MountShape[] {
  return mounts
    .filter((mount) => CODEX_CONTAINER_PATHS.includes(mount.containerPath))
    .map(({ containerPath, hostPath, readonly }) => ({ containerPath, hostPath, readonly }));
}

function expectedCodexMounts(groupDir: string, codexShared: string): MountShape[] {
  const agentsDir = path.join(groupDir, '.agents');
  return [
    { containerPath: '/home/node/.codex', hostPath: codexShared, readonly: false },
    { containerPath: '/workspace/agent/.agents', hostPath: agentsDir, readonly: true },
    { containerPath: '/home/node/.agents', hostPath: agentsDir, readonly: true },
    { containerPath: '/workspace/agent/AGENTS.md', hostPath: path.join(groupDir, 'AGENTS.md'), readonly: true },
  ];
}

function byContainerPath(mounts: readonly MountShape[]): MountShape[] {
  return [...mounts].sort((left, right) => left.containerPath.localeCompare(right.containerPath));
}

describe('codex host contribution against real core', () => {
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

  it('creates the per-group state dir, composes AGENTS.md from the real config row, and mounts both', async () => {
    const ag = group('ag-codex', 'codex-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', instructions: 'use the tooling server for builds' },
    });
    const groupDir = path.join(GROUPS_DIR, ag.folder);

    const contributionFn = getProviderContainerConfig('codex');
    expect(contributionFn).toBeDefined();
    const contribution = await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: [],
      hostEnv: process.env,
    });

    // Per-group codex state dir exists and is mounted RW at ~/.codex.
    const codexShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.codex-shared');
    expect(fs.existsSync(codexShared)).toBe(true);
    // OneCLI's auth-stub mountpoint is pre-created — on macOS Docker can't
    // create a missing file mountpoint inside a virtiofs dir mount (exit 125
    // on first spawn). Red here = the pre-create line was dropped.
    expect(fs.existsSync(path.join(codexShared, 'auth.json'))).toBe(true);
    const codexMount = contribution.mounts?.find((m) => m.containerPath === '/home/node/.codex');
    expect(codexMount).toMatchObject({ hostPath: codexShared, readonly: false });

    // AGENTS.md composed from the real DB row — MCP instructions included.
    const agentsMd = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('MCP Server: tooling');
    expect(agentsMd).toContain('use the tooling server for builds');

    // The full mount set: codex surfaces in, default claude surfaces out.
    const session = { id: 'session-1', agent_group_id: ag.id } as Session;
    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const mounts = await buildMounts(ag, session, config, 'codex', contribution);
    const containerPaths = mounts.map((m) => m.containerPath);
    // The same four codex mounts on either core generation; only their order
    // differs (the contract core realizes declared surfaces first), so the set
    // is asserted here and the order in the contract-core test below.
    expect(byContainerPath(codexMounts(mounts))).toEqual(byContainerPath(expectedCodexMounts(groupDir, codexShared)));
    expect(containerPaths).not.toContain('/home/node/.claude');
  });

  newCoreIt('orders the declared codex surfaces ahead of the composed AGENTS.md', async () => {
    const ag = group('ag-codex-order', 'codex-order-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const contribution = await getProviderContainerConfig('codex')!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: [],
      hostEnv: process.env,
    });
    const session = { id: 'session-1', agent_group_id: ag.id } as Session;
    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const mounts = await buildMounts(ag, session, config, 'codex', contribution);
    const codexShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.codex-shared');
    expect(codexMounts(mounts)).toEqual(expectedCodexMounts(groupDir, codexShared));
  });

  it('mirrors per-group template skills from the Claude plane into .agents/skills', async () => {
    const ag = group('ag-codex-skills', 'codex-skills-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    // A template stamps its skills as real dirs on the Claude plane; codex reads
    // .agents/skills (RO-mounted), so the contribution must mirror them there.
    const templateSkill = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills', 'widget');
    fs.mkdirSync(templateSkill, { recursive: true });
    fs.writeFileSync(path.join(templateSkill, 'SKILL.md'), '---\nname: widget\n---\n');

    const contributionFn = getProviderContainerConfig('codex');
    await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: [],
      hostEnv: process.env,
    });

    const mirrored = path.join(GROUPS_DIR, ag.folder, '.agents', 'skills', 'widget');
    expect(fs.existsSync(path.join(mirrored, 'SKILL.md'))).toBe(true);
    // A real dir, not a symlink — so it survives syncCodexSkillLinks' symlink-only prune.
    expect(fs.lstatSync(mirrored).isSymbolicLink()).toBe(false);
  });

  newCoreIt('lets new core realize declared surfaces without legacy duplicates', async () => {
    const ag = group('ag-codex-contract', 'codex-contract-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const session = { id: 'session-contract', agent_group_id: ag.id } as Session;
    const config: ContainerConfig = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    };
    const context = {
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, session.id),
      agentGroupId: ag.id,
      groupDir,
      selectedSkills: [],
      hostEnv: process.env,
      coreOwnsProviderSurfaces: true as const,
    };

    const contribution = await getProviderContainerConfig('codex')!(context);
    expect(contribution).toEqual({});

    const mounts = await buildMounts(ag, session, config, 'codex', contribution);
    expect(mounts.filter((mount) => mount.containerPath === '/home/node/.codex')).toHaveLength(1);
    expect(mounts.filter((mount) => mount.containerPath === '/workspace/agent/AGENTS.md')).toHaveLength(1);
    for (const destination of ['/workspace/agent/.agents', '/home/node/.agents']) {
      expect(mounts.find((mount) => mount.containerPath === destination)?.hostPath).toBe(
        path.join(groupDir, '.agents'),
      );
    }
    expect(fs.existsSync(path.join(groupDir, '.agents', 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', ag.id, '.codex-shared', 'auth.json'))).toBe(true);
  });
});
