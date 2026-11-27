/**
 * In-process seam test for the antigravity HOST payload against real core:
 * the registered adapter is driven through the real barrel and registry, and
 * on a contract core the declared contract runs through the real spawn path
 * (resolveProviderContribution → buildMounts) against a test DB and a temp
 * GROUPS_DIR/DATA_DIR.
 *
 * What it pins down: the placeholder GEMINI_API_KEY and the auto-update kill
 * switch in the env, the per-group `.gemini-shared` home mounted RW at
 * ~/.gemini, skills linked under ~/.gemini/config/skills, the RO AGENTS.md
 * mount, and the gateway-facing model domains. On a contract core the
 * ~/.gemini mount uses the same host directory and RW mode the pre-contract
 * adapter returns; core adds the composed AGENTS.md on top, which the adapter
 * never mounted.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-antigravity-host-contribution-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const hasContractCore = fs.existsSync(path.join(process.cwd(), 'src/provider-contracts/realize.ts'));
const contractIt = hasContractCore ? it : it.skip;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-antigravity-host-contribution-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-antigravity-host-contribution-test/groups',
}));

import { buildMounts, resolveProviderContribution } from '../container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { getProviderContainerConfig } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel
import type { ContainerConfig } from '../container-config.js';
import type { AgentGroup, Session } from '../types.js';

if (hasContractCore) {
  // In an install the contract barrel loads this; here it is imported directly
  // so the test does not depend on the barrel line the skill appends.
  await import('../provider-contracts/antigravity.js');
}

const ENV = { GEMINI_API_KEY: 'nc-antigravity-placeholder', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

type MountShape = { containerPath: string; hostPath: string; readonly: boolean };

const ANTIGRAVITY_CONTAINER_PATHS = ['/home/node/.gemini', '/workspace/agent/AGENTS.md'];

function antigravityMounts(mounts: readonly MountShape[]): MountShape[] {
  return mounts
    .filter((mount) => ANTIGRAVITY_CONTAINER_PATHS.includes(mount.containerPath))
    .map(({ containerPath, hostPath, readonly }) => ({ containerPath, hostPath, readonly }));
}

/**
 * The Antigravity mounts a contract core must produce, in order: agy's home
 * (identical to the one mount the pre-contract adapter returns), then the
 * core-composed AGENTS.md, read-only.
 */
function expectedContractMounts(groupDir: string, geminiShared: string): MountShape[] {
  return [
    { containerPath: '/home/node/.gemini', hostPath: geminiShared, readonly: false },
    { containerPath: '/workspace/agent/AGENTS.md', hostPath: path.join(groupDir, 'AGENTS.md'), readonly: true },
  ];
}

const CONFIG: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: ['welcome'],
  provider: 'antigravity',
} as ContainerConfig;

describe('antigravity host payload against real core', () => {
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

  it('legacy adapter: creates agy home, mounts it RW at ~/.gemini, and passes the placeholder key', async () => {
    const ag = group('ag-agy-legacy', 'agy-legacy');
    const contributionFn = getProviderContainerConfig('antigravity');
    expect(contributionFn).toBeDefined();
    const contribution = await contributionFn!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: ['welcome'],
      hostEnv: process.env,
    });

    const geminiShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.gemini-shared');
    expect(fs.existsSync(geminiShared)).toBe(true);
    expect(contribution.mounts).toEqual([
      { hostPath: geminiShared, containerPath: '/home/node/.gemini', readonly: false },
    ]);
    expect(contribution.env).toEqual(ENV);
  });

  it('legacy adapter: contributes only the env once core owns the surfaces', async () => {
    const ag = group('ag-agy-owned', 'agy-owned');
    const contribution = await getProviderContainerConfig('antigravity')!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', ag.id, 'session-1'),
      agentGroupId: ag.id,
      groupDir: path.join(GROUPS_DIR, ag.folder),
      selectedSkills: ['welcome'],
      hostEnv: process.env,
      coreOwnsProviderSurfaces: true,
    });
    expect(contribution).toEqual({ env: ENV });
    // Nothing on disk: core creates the state dir from the contract.
    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', ag.id, '.gemini-shared'))).toBe(false);
  });

  it('never hands the container a real-looking Google API key', async () => {
    const contribution = await getProviderContainerConfig('antigravity')!({
      sessionDir: path.join(DATA_DIR, 'v2-sessions', 'ag', 'session-1'),
      agentGroupId: 'ag',
      groupDir: path.join(GROUPS_DIR, 'ag'),
      selectedSkills: [],
      hostEnv: { ...process.env, GEMINI_API_KEY: 'AIzaHostValueThatMustNotLeak0000000000', GOOGLE_API_KEY: 'x' },
      coreOwnsProviderSurfaces: true,
    });
    expect(contribution.env?.GEMINI_API_KEY).toBe('nc-antigravity-placeholder');
    expect(Object.keys(contribution.env ?? {}).sort()).toEqual(['AGY_CLI_DISABLE_AUTO_UPDATE', 'GEMINI_API_KEY']);
  });

  contractIt('contract core: exempts the Gemini API and agy telemetry hosts from gateway approval', async () => {
    const { getProviderModelEndpoint, providerModelAllowedHosts } = await import('../provider-contracts/registry.js');
    expect(getProviderModelEndpoint('antigravity', 'api')).toBe('https://generativelanguage.googleapis.com');
    expect(providerModelAllowedHosts()).toEqual(
      expect.arrayContaining(['generativelanguage.googleapis.com', 'play.googleapis.com']),
    );
  });

  contractIt('contract core: the real spawn path realizes the declared surfaces and composes AGENTS.md', async () => {
    const ag = group('ag-agy', 'agy-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', instructions: 'use the tooling server for builds' },
    });
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    // A template stamps its skills as real dirs on the Claude plane; the
    // contract copies them into agy's skills directory.
    const templateSkill = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills', 'widget');
    fs.mkdirSync(templateSkill, { recursive: true });
    fs.writeFileSync(path.join(templateSkill, 'SKILL.md'), '---\nname: widget\n---\n');
    const session = { id: 'session-1', agent_group_id: ag.id, agent_provider: null } as Session;

    const { provider, contribution, surfaces } = await resolveProviderContribution(session, ag, CONFIG);
    expect(provider).toBe('antigravity');
    expect(contribution).toEqual({ env: ENV });

    const geminiShared = path.join(DATA_DIR, 'v2-sessions', ag.id, '.gemini-shared');
    const skillsDir = path.join(geminiShared, 'config', 'skills');
    expect(fs.readlinkSync(path.join(skillsDir, 'welcome'))).toBe('/app/skills/welcome');
    expect(fs.lstatSync(path.join(skillsDir, 'widget')).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'widget', 'SKILL.md'))).toBe(true);
    // No project-level skills layer: agy discovers global skills only.
    expect(fs.existsSync(path.join(groupDir, '.gemini'))).toBe(false);

    const agentsMd = fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8');
    expect(Buffer.byteLength(agentsMd)).toBeLessThanOrEqual(24 * 1024);
    expect(agentsMd).toContain('MCP Server: tooling');
    expect(agentsMd).toContain('use the tooling server for builds');
    expect(agentsMd).toContain('# Native Runtime Skills');
    expect(agentsMd).toContain('`/home/node/.gemini/config/skills`');
    expect(agentsMd).toContain('`~/.gemini/config/skills/<name>/SKILL.md`');
    expect(agentsMd).toContain('Do not use `GEMINI.md` or `.agents` for memory.');

    const mounts = await buildMounts(ag, session, CONFIG, provider, contribution, surfaces);
    expect(antigravityMounts(mounts)).toEqual(expectedContractMounts(groupDir, geminiShared));
    const containerPaths = mounts.map((mount) => mount.containerPath);
    expect(containerPaths).not.toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/workspace/agent/CLAUDE.md');
    // The skills directory rides inside the home volume; no separate view mount.
    expect(containerPaths.filter((entry) => entry.includes('.gemini'))).toEqual(['/home/node/.gemini']);
    for (const mount of mounts.filter((entry) => ANTIGRAVITY_CONTAINER_PATHS.includes(entry.containerPath))) {
      expect(mount.mountClass).toBe('allowlisted-extra');
    }
  });

  contractIt('contract core: isolates agy conversation state between agent groups', async () => {
    const first = group('ag-agy-first', 'agy-first');
    const second = group('ag-agy-second', 'agy-second');
    const hostPaths: string[] = [];
    for (const ag of [first, second]) {
      await createAgentGroup(ag);
      await ensureContainerConfig(ag.id);
      fs.mkdirSync(path.join(GROUPS_DIR, ag.folder), { recursive: true });
      const session = { id: 'session-1', agent_group_id: ag.id, agent_provider: null } as Session;
      const { contribution, surfaces } = await resolveProviderContribution(session, ag, CONFIG);
      const mounts = await buildMounts(ag, session, CONFIG, 'antigravity', contribution, surfaces);
      hostPaths.push(mounts.find((mount) => mount.containerPath === '/home/node/.gemini')!.hostPath);
    }
    expect(hostPaths).toEqual([
      path.join(DATA_DIR, 'v2-sessions', first.id, '.gemini-shared'),
      path.join(DATA_DIR, 'v2-sessions', second.id, '.gemini-shared'),
    ]);
  });
});
