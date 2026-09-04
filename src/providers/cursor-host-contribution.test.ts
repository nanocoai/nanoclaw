/**
 * In-process seam test for the cursor HOST payload's runtime consumption of
 * core: drive the REAL registered adapter — via the real barrel and registry,
 * never by importing cursor.ts's internals — and, on a contract core, the
 * REAL declared contract through the real spawn path (resolveProviderContribution
 * → buildMounts) against a real test DB and a temp GROUPS_DIR/DATA_DIR.
 *
 * What it pins down: the `.cursor-shared` state directory and its RW mount at
 * ~/.cursor, the RO AGENTS.md mount, the placeholder env, the two skill
 * directories, and that the contract core produces exactly the mount set the
 * pre-contract adapter produced by hand.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-cursor-host-contribution-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const hasContractCore = fs.existsSync(path.join(process.cwd(), 'src/provider-contracts/realize.ts'));
const contractIt = hasContractCore ? it : it.skip;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-cursor-host-contribution-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-cursor-host-contribution-test/groups',
}));

import { buildMounts, resolveProviderContribution } from '../container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';

if (hasContractCore) {
  // The contract registers itself on import; in an install the contract barrel
  // does this, here it is loaded directly so the test does not depend on the
  // barrel line the skill appends.
  await import('../provider-contracts/cursor.js');
}

const PLACEHOLDER = 'cursor_placeholder_nanoclaw';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

type MountShape = { containerPath: string; hostPath: string; readonly: boolean };

const CURSOR_CONTAINER_PATHS = ['/home/node/.cursor', '/workspace/agent/AGENTS.md'];

function cursorMounts(mounts: readonly MountShape[]): MountShape[] {
  return mounts
    .filter((mount) => CURSOR_CONTAINER_PATHS.includes(mount.containerPath))
    .map(({ containerPath, hostPath, readonly }) => ({ containerPath, hostPath, readonly }));
}

/** The mount set the pre-contract adapter produced: state dir first, then the composed doc. */
function legacyCursorMounts(groupDir: string, cursorShared: string): MountShape[] {
  return [
    { containerPath: '/home/node/.cursor', hostPath: cursorShared, readonly: false },
    { containerPath: '/workspace/agent/AGENTS.md', hostPath: path.join(groupDir, 'AGENTS.md'), readonly: true },
  ];
}

const CONFIG: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: ['welcome'],
  provider: 'cursor',
} as ContainerConfig;

describe('cursor host payload against real core', () => {
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

  it('legacy adapter: creates the state dir, mounts it RW at ~/.cursor, and passes the placeholder key', async () => {
    const ag = group('ag-cursor-legacy', 'cursor-legacy');
    const contributionFn = getProviderContainerConfig('cursor');
    expect(contributionFn).toBeDefined();
    const contribution = await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: ['welcome'],
      hostEnv: process.env,
    });

    const cursorShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.cursor-shared');
    expect(fs.existsSync(cursorShared)).toBe(true);
    expect(contribution.mounts).toEqual([
      { hostPath: cursorShared, containerPath: '/home/node/.cursor', readonly: false },
    ]);
    expect(contribution.env).toEqual({ CURSOR_API_KEY: PLACEHOLDER });
  });

  it('legacy adapter: contributes only the env once core owns the surfaces', async () => {
    const ag = group('ag-cursor-owned', 'cursor-owned');
    const contribution = await getProviderContainerConfig('cursor')!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: ['welcome'],
      hostEnv: process.env,
      coreOwnsProviderSurfaces: true,
    });
    expect(contribution).toEqual({ env: { CURSOR_API_KEY: PLACEHOLDER } });
    // Nothing on disk: core creates the state dir from the contract.
    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', ag.id, '.cursor-shared'))).toBe(false);
  });

  contractIt('contract core: the real spawn path realizes the declared surfaces and composes AGENTS.md', async () => {
    const ag = group('ag-cursor', 'cursor-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', instructions: 'use the tooling server for builds' },
    });
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    // A template stamps its skills as real dirs on the Claude plane; the
    // contract mirrors them into both Cursor skill directories.
    const templateSkill = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills', 'widget');
    fs.mkdirSync(templateSkill, { recursive: true });
    fs.writeFileSync(path.join(templateSkill, 'SKILL.md'), '---\nname: widget\n---\n');
    const session = { id: 'session-1', agent_group_id: ag.id, agent_provider: null } as Session;

    const { provider, contribution, surfaces } = await resolveProviderContribution(session, ag, CONFIG);
    expect(provider).toBe('cursor');
    expect(contribution).toEqual({ env: { CURSOR_API_KEY: PLACEHOLDER } });

    const cursorShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.cursor-shared');
    expect(fs.existsSync(cursorShared)).toBe(true);
    for (const skillsDir of [path.join(groupDir, '.cursor', 'skills'), path.join(cursorShared, 'skills')]) {
      expect(fs.readlinkSync(path.join(skillsDir, 'welcome'))).toBe('/app/skills/welcome');
      expect(fs.lstatSync(path.join(skillsDir, 'widget')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(skillsDir, 'widget', 'SKILL.md'))).toBe(true);
    }

    const agentsMd = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('MCP Server: tooling');
    expect(agentsMd).toContain('use the tooling server for builds');
    expect(agentsMd).toContain('# Native Runtime Skills');
    expect(agentsMd).toContain('`/workspace/agent/.cursor/skills`');
    expect(agentsMd).toContain('`~/.cursor/skills/<name>/SKILL.md`');
    expect(agentsMd).toContain('Do not use `.cursorrules` or `CLAUDE.md` or `CLAUDE.local.md` for memory.');

    const mounts = await buildMounts(ag, session, CONFIG, provider, contribution, surfaces);
    expect(cursorMounts(mounts)).toEqual(legacyCursorMounts(groupDir, cursorShared));
    const containerPaths = mounts.map((mount) => mount.containerPath);
    expect(containerPaths).not.toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/workspace/agent/CLAUDE.md');
    expect(containerPaths.filter((entry) => entry === '/home/node/.cursor')).toHaveLength(1);
    // No skill-view mounts: both skill directories are reached through the
    // group mount and the state volume, as the adapter never mounted them.
    expect(containerPaths.filter((entry) => entry.includes('.cursor'))).toEqual(['/home/node/.cursor']);
    for (const mount of mounts.filter((entry) => CURSOR_CONTAINER_PATHS.includes(entry.containerPath))) {
      expect(mount.mountClass).toBe('allowlisted-extra');
    }
  });

  contractIt('contract core: isolates persistent Cursor state between agent groups', async () => {
    const first = group('ag-cursor-first', 'cursor-first');
    const second = group('ag-cursor-second', 'cursor-second');
    const hostPaths: string[] = [];
    for (const ag of [first, second]) {
      await createAgentGroup(ag);
      await ensureContainerConfig(ag.id);
      fs.mkdirSync(path.join(GROUPS_DIR, ag.folder), { recursive: true });
      const session = { id: 'session-1', agent_group_id: ag.id, agent_provider: null } as Session;
      const { contribution, surfaces } = await resolveProviderContribution(session, ag, CONFIG);
      const mounts = await buildMounts(ag, session, CONFIG, 'cursor', contribution, surfaces);
      hostPaths.push(mounts.find((mount) => mount.containerPath === '/home/node/.cursor')!.hostPath);
    }
    expect(hostPaths).toEqual([
      path.join(DATA_DIR, 'v2-sessions', first.id, '.cursor-shared'),
      path.join(DATA_DIR, 'v2-sessions', second.id, '.cursor-shared'),
    ]);
  });
});
