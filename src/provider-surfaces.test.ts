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
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { log } from './log.js';
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
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('initGroupFilesystem agent surfaces', () => {
  it('stages provider-neutral instructions and default Claude support files', () => {
    const ag = group('ag-default', 'default-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const claudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('hello\n');
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(claudeDir, 'skills'))).toBe(true);
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8'));
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(settings.hooks.SessionStart).toBeUndefined();
  });

  it('disables native Claude memory in existing settings without clobbering other values', () => {
    const ag = group('ag-existing-claude', 'existing-claude-group');
    createAgentGroup(ag);
    initGroupFilesystem(ag);

    const settingsFile = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    settings.autoMemoryEnabled = true;
    settings.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0';
    settings.customValue = 'preserved';
    settings.hooks.SessionStart = [
      { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
      { matcher: '.*', hooks: [{ type: 'command', command: 'bun /app/src/memory-hook.ts' }] },
    ];
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

    initGroupFilesystem(ag);

    const reconciled = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(reconciled.autoMemoryEnabled).toBe(false);
    expect(reconciled.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(reconciled.customValue).toBe('preserved');
    expect(reconciled.hooks.SessionStart).toEqual([
      { matcher: 'resume', hooks: [{ type: 'command', command: 'custom-resume' }] },
    ]);
    expect(JSON.stringify(reconciled.hooks.PreCompact)).toContain('compact-instructions.ts');
  });

  it.each([
    ['malformed JSON', '{"hooks":'],
    ['a non-object root', '[]\n'],
  ])('warns and leaves existing settings unchanged for %s', (_label, content) => {
    const ag = group('ag-invalid-claude', 'invalid-claude-group');
    createAgentGroup(ag);
    initGroupFilesystem(ag);

    const settingsFile = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    fs.writeFileSync(settingsFile, content);

    initGroupFilesystem(ag);

    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(content);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Claude settings'),
      expect.objectContaining({ settingsFile }),
    );
  });

  it('stages the same provider-neutral instructions for a provider with its own surfaces', () => {
    const ag = group('ag-surfy', 'surfy-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { instructions: 'hello', provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sessionRoot = path.join(DATA_DIR, 'v2-sessions', ag.id);
    expect(fs.existsSync(groupDir)).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('hello\n');
    expect(fs.existsSync(path.join(sessionRoot, '.claude-shared'))).toBe(false);
  });

  it('writes nothing at all for a surfaces-owning provider without instructions', () => {
    const ag = group('ag-surfy-bare', 'surfy-bare-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, PERSONA_PREPEND_FILE))).toBe(false);
  });

  it('treats an unregistered provider name as default support files without creating memory', () => {
    const ag = group('ag-unknown', 'unknown-group');
    createAgentGroup(ag);

    initGroupFilesystem(ag, { provider: 'not-registered' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });
});

describe('initGroupFilesystem legacy seed isolation', () => {
  it('leaves .seed.md untouched for the manual migration workflow', () => {
    const ag = group('ag-seed', 'seed-group');
    createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.seed.md'), 'seeded identity\n');

    initGroupFilesystem(ag, {});

    expect(fs.readFileSync(path.join(groupDir, '.seed.md'), 'utf-8')).toBe('seeded identity\n');
    expect(fs.existsSync(path.join(groupDir, PERSONA_PREPEND_FILE))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
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
