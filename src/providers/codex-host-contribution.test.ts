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

describe('codex host contribution against real core', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(GROUPS_DIR, { recursive: true });
    runMigrations(initTestDb());
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('creates the per-group state dir, composes AGENTS.md from the real config row, and mounts both', () => {
    const ag = group('ag-codex', 'codex-group');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    updateContainerConfigJson(ag.id, 'mcp_servers', {
      tooling: { command: 'x', instructions: 'use the tooling server for builds' },
    });
    const groupDir = path.join(GROUPS_DIR, ag.folder);

    const contributionFn = getProviderContainerConfig('codex');
    expect(contributionFn).toBeDefined();
    const contribution = contributionFn!({
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
    const mounts = buildMounts(ag, session, config, 'codex', contribution);
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).toContain('/home/node/.codex');
    expect(containerPaths.some((p) => p.endsWith('AGENTS.md'))).toBe(true);
    expect(containerPaths).not.toContain('/home/node/.claude');
  });

  it('mirrors per-group template skills from the Claude plane into .agents/skills', () => {
    const ag = group('ag-codex-skills', 'codex-skills-group');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    // A template stamps its skills as real dirs on the Claude plane; codex reads
    // .agents/skills (RO-mounted), so the contribution must mirror them there.
    const templateSkill = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills', 'widget');
    fs.mkdirSync(templateSkill, { recursive: true });
    fs.writeFileSync(path.join(templateSkill, 'SKILL.md'), '---\nname: widget\n---\n');

    const contributionFn = getProviderContainerConfig('codex');
    contributionFn!({
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
});
