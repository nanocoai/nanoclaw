import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ROOT, GROUPS_DIR, DATA_DIR } = vi.hoisted(() => {
  const root = '/tmp/nanoclaw-test-cr-temporal';
  return { ROOT: root, GROUPS_DIR: `${root}/groups`, DATA_DIR: `${root}/data` };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR, DATA_DIR };
});

import { composeGroupClaudeMd } from './claude-md-compose.js';
import { buildMounts } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

function now() {
  return new Date().toISOString();
}

const folder = 'incognito-group';
const ag = `ag-${randomUUID()}`;
const agentGroup: AgentGroup = { id: ag, name: 'Agent', folder, agent_provider: null, created_at: now() };

const cfg: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: 'all',
};

function session(temporal: 0 | 1): Session {
  return {
    id: `sess-${randomUUID()}`,
    agent_group_id: ag,
    messaging_group_id: `mg-${randomUUID()}`,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
    temporal,
  };
}

describe('temporal container mounts', () => {
  beforeEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({ id: ag, name: 'Agent', folder, agent_provider: null, created_at: now() });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('temporal session mounts a fresh ephemeral workspace + isolated .claude, not the group', () => {
    const sess = session(1);
    const mounts = buildMounts(agentGroup, sess, cfg, 'claude', {});

    const sessDir = path.join(DATA_DIR, 'v2-sessions', ag, sess.id);
    const agentMount = mounts.find((m) => m.containerPath === '/workspace/agent');
    const claudeMount = mounts.find((m) => m.containerPath === '/home/node/.claude');

    expect(agentMount?.hostPath).toBe(path.join(sessDir, 'agent-ephemeral'));
    expect(claudeMount?.hostPath).toBe(path.join(sessDir, 'claude-ephemeral'));

    // The group dir and the shared .claude-shared must NEVER be mounted.
    expect(mounts.some((m) => m.hostPath === path.join(GROUPS_DIR, folder))).toBe(false);
    expect(mounts.some((m) => m.hostPath.includes('.claude-shared'))).toBe(false);

    // Operating instructions composed into the ephemeral workspace, memory empty.
    expect(fs.existsSync(path.join(agentMount!.hostPath, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(agentMount!.hostPath, 'CLAUDE.local.md'), 'utf-8')).toBe('');
  });

  it('normal session still mounts the group dir + shared .claude-shared', () => {
    const sess = session(0);
    const mounts = buildMounts(agentGroup, sess, cfg, 'claude', {});

    const agentMount = mounts.find((m) => m.containerPath === '/workspace/agent');
    const claudeMount = mounts.find((m) => m.containerPath === '/home/node/.claude');

    expect(agentMount?.hostPath).toBe(path.join(GROUPS_DIR, folder));
    expect(claudeMount?.hostPath).toBe(path.join(DATA_DIR, 'v2-sessions', ag, '.claude-shared'));
  });

  it('drops a provider mount rooted under the group dir but keeps out-of-group mounts', () => {
    const sess = session(1);
    const groupLeak = {
      hostPath: path.join(GROUPS_DIR, folder, 'secret-memory'),
      containerPath: '/workspace/agent/leak',
      readonly: false,
    };
    const sessionScoped = {
      hostPath: path.join(DATA_DIR, 'v2-sessions', ag, sess.id, 'xdg'),
      containerPath: '/home/node/.xdg',
      readonly: false,
    };

    const mounts = buildMounts(agentGroup, sess, cfg, 'claude', { mounts: [groupLeak, sessionScoped] });

    expect(mounts.some((m) => m.hostPath === groupLeak.hostPath)).toBe(false);
    expect(mounts.some((m) => m.hostPath === sessionScoped.hostPath)).toBe(true);
  });

  it('composeGroupClaudeMd(group, outputDir) writes to outputDir, not the group dir', () => {
    const outDir = path.join(ROOT, 'compose-out');
    composeGroupClaudeMd(agentGroup, outDir);

    expect(fs.existsSync(path.join(outDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(outDir, 'CLAUDE.local.md'))).toBe(true);
    // The real group dir is left untouched.
    expect(fs.existsSync(path.join(GROUPS_DIR, folder, 'CLAUDE.md'))).toBe(false);
  });
});
