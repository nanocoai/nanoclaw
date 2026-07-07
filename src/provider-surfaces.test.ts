import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-provider-surfaces-test';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const DATA_DIR = path.join(TEST_ROOT, 'data');

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-provider-surfaces-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-provider-surfaces-test/groups',
}));

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { buildMounts } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { initGroupFilesystem } from './group-init.js';
import { registerProviderContainerConfig } from './providers/provider-container-registry.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

// A provider that declares (at registration) that it owns its agent surfaces.
// Registered once — the registry is module-global and rejects duplicates.
registerProviderContainerConfig('surfaces-test-provider', () => ({}), { providesAgentSurfaces: true });

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function session(id: string, agentGroupId: string): Session {
  return { id, agent_group_id: agentGroupId } as Session;
}

function containerConfig(): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] };
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('initGroupFilesystem agent surfaces', () => {
  it('writes the default surfaces when no provider is given (today’s behavior)', () => {
    const ag = group('ag-default', 'default-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('hello\n');
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'skills'))).toBe(true);
  });

  it('writes the seed into the memory scaffold — never CLAUDE.* — for a provider with its own surfaces', () => {
    const ag = group('ag-surfy', 'surfy-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello', provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sessionRoot = path.join(DATA_DIR, 'v2-sessions', ag.id);
    expect(fs.existsSync(groupDir)).toBe(true);
    // A fresh group on a surfaces-owning provider must not contain stale
    // Claude surfaces; its seed lands in the scaffold's conventional file,
    // which the container-side scaffold preserves at boot.
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, 'memory', 'memories', 'imported-agent-memory.md'), 'utf-8')).toBe(
      'hello\n',
    );
    expect(fs.existsSync(path.join(sessionRoot, '.claude-shared'))).toBe(false);
  });

  it('writes nothing at all for a surfaces-owning provider without instructions', () => {
    const ag = group('ag-surfy-bare', 'surfy-bare-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });

  it('treats an unregistered provider name as default surfaces', () => {
    const ag = group('ag-unknown', 'unknown-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'not-registered' });

    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.local.md'))).toBe(true);
  });
});

describe('initGroupFilesystem deferred seed (.seed.md)', () => {
  // Creation is provider-agnostic: the DM-agent creators drop a neutral
  // `.seed.md` and defer placement to the first spawn, where the DB-resolved
  // provider is known. group-init places it into the right surface and
  // consumes it. Red-on-delete: if that placement is removed, these fail.
  it('places .seed.md into CLAUDE.local.md for the default provider, then consumes it', () => {
    const ag = group('ag-seed-default', 'seed-default');
    createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.seed.md'), 'seeded identity\n');

    initGroupFilesystem(ag, {}); // no inline instructions — must read .seed.md

    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.local.md'), 'utf-8')).toBe('seeded identity\n');
    expect(fs.existsSync(path.join(groupDir, '.seed.md'))).toBe(false);
  });

  it('places .seed.md into the memory scaffold (never CLAUDE.*) for a surfaces-owning provider, then consumes it', () => {
    const ag = group('ag-seed-surfy', 'seed-surfy');
    createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.seed.md'), 'seeded identity\n');

    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, 'memory', 'memories', 'imported-agent-memory.md'), 'utf-8')).toBe(
      'seeded identity\n',
    );
    expect(fs.existsSync(path.join(groupDir, '.seed.md'))).toBe(false);
  });
});

describe('buildMounts agent surfaces', () => {
  it('mounts the default surfaces for an unregistered provider (today’s behavior)', () => {
    const ag = group('ag-mounts-default', 'mounts-default');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, {});

    const mounts = buildMounts(ag, session('s1', ag.id), containerConfig(), 'claude', {});

    const byContainerPath = new Map(mounts.map((m) => [m.containerPath, m]));
    expect(byContainerPath.has('/home/node/.claude')).toBe(true);
    expect(byContainerPath.has('/app/CLAUDE.md')).toBe(true);
    expect(byContainerPath.has('/workspace/agent/CLAUDE.md')).toBe(true);
    // Composer ran: the generated project doc exists on disk.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(true);
  });

  it('suppresses the default surfaces and keeps contributed mounts for a surfaces-providing provider', () => {
    const ag = group('ag-mounts-surfy', 'mounts-surfy');
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const contributed = {
      mounts: [
        {
          hostPath: path.join(GROUPS_DIR, ag.folder),
          containerPath: '/workspace/agent/OWN-DOC.md',
          readonly: true,
        },
      ],
    };
    const mounts = buildMounts(ag, session('s2', ag.id), containerConfig(), 'surfaces-test-provider', contributed);

    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).not.toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/app/CLAUDE.md');
    expect(containerPaths).not.toContain('/workspace/agent/CLAUDE.md');
    // Composer did NOT run for this group.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(false);
    // Core mounts and the provider's own contribution are intact.
    expect(containerPaths).toContain('/workspace');
    expect(containerPaths).toContain('/workspace/agent');
    expect(containerPaths).toContain('/app/src');
    expect(containerPaths).toContain('/workspace/agent/OWN-DOC.md');
  });
});
