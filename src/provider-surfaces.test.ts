import { execFileSync, spawnSync } from 'child_process';
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
vi.mock('./modules/mount-security/index.js', () => ({
  validateAdditionalMounts: vi.fn((mounts) =>
    mounts.map((mount: { hostPath: string; containerPath?: string; readonly?: boolean }) => ({
      hostPath: mount.hostPath,
      containerPath: `/workspace/extra/${mount.containerPath ?? path.basename(mount.hostPath)}`,
      readonly: mount.readonly ?? true,
    })),
  ),
}));

import { buildMounts, resolveProviderContribution } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { getGatewayProvider, registerGatewayProvider, resetGatewayProvider } from './gateway-providers/index.js';
import { initGroupFilesystem } from './group-init.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { log } from './log.js';
import {
  initializeProviderGroupSurfaces,
  protectedProviderDocumentSourcePaths,
  realizeProviderSpawnSurfaces,
} from './provider-contracts/realize.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  registerProviderHostContract,
  type ProviderHostContract,
} from './provider-contracts/registry.js';
import { registerProviderContainerConfig } from './providers/provider-container-registry.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

// A provider that declares (at registration) that it owns its agent surfaces.
// Registered once — the registry is module-global and rejects duplicates.
registerProviderContainerConfig('surfaces-test-provider', () => ({}), { providesAgentSurfaces: true });
const oldPayloadContribution = vi.fn(() => ({ env: { COMPAT: 'legacy' } }));
registerProviderContainerConfig('old-payload-provider', oldPayloadContribution, { providesAgentSurfaces: true });
const currentPayloadContribution = vi.fn((ctx: { groupDir: string }) => ({
  env: { COMPAT: 'current' },
  mounts: [{ hostPath: ctx.groupDir, containerPath: '/home/node/.codex', readonly: false }],
}));
registerProviderContainerConfig('ordered-mount-provider', currentPayloadContribution, {
  providesAgentSurfaces: true,
});
registerProviderHostContract('ordered-mount-provider', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  projectDocument: {
    fileName: 'AGENTS.md',
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
  },
  stateVolumes: [
    {
      id: 'ordered-state',
      directory: '.ordered-state',
      containerPath: '/home/node/.codex',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      id: 'ordered-skills',
      location: { kind: 'state-volume', volumeId: 'ordered-state', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'in-place',
    },
  ],
  skillViews: [
    {
      backingId: 'ordered-skills',
      containerPath: '/workspace/agent/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
    {
      backingId: 'ordered-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
    },
  ],
  files: [],
  commands: { nativeAdmin: [], nativeFiltered: [] },
});

registerProviderHostContract('partial-install-provider', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  projectDocument: {
    fileName: 'AGENTS.md',
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'group-state',
  },
  stateVolumes: [],
  skillBackings: [],
  skillViews: [],
  files: [],
  legacyHostAdapter: 'required',
  commands: { nativeAdmin: [], nativeFiltered: [] },
});

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function session(id: string, agentGroupId: string): Session {
  return { id, agent_group_id: agentGroupId } as Session;
}

function containerConfig(): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] };
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('initGroupFilesystem agent surfaces', () => {
  it('stages provider-neutral instructions and default Claude support files', async () => {
    const ag = group('ag-default', 'default-group');
    await createAgentGroup(ag);

    await initGroupFilesystem(ag, { instructions: 'hello' });

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

  it('disables native Claude memory in existing settings without clobbering other values', async () => {
    const ag = group('ag-existing-claude', 'existing-claude-group');
    await createAgentGroup(ag);
    await initGroupFilesystem(ag);

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

    await initGroupFilesystem(ag);

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
  ])('warns and leaves existing settings unchanged for %s', async (_label, content) => {
    const ag = group('ag-invalid-claude', 'invalid-claude-group');
    await createAgentGroup(ag);
    await initGroupFilesystem(ag);

    const settingsFile = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
    fs.writeFileSync(settingsFile, content);

    await initGroupFilesystem(ag);

    expect(fs.readFileSync(settingsFile, 'utf-8')).toBe(content);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Claude settings'),
      expect.objectContaining({ settingsFile }),
    );
  });

  async function makeGroupLocal(id: string) {
    const ag = group(id, `${id}-group`);
    await createAgentGroup(ag);
    return ag;
  }

  describe('declared settings.json planted by the container', () => {
    // `.claude-shared` is the container's read-write mount: any name under it
    // may be a symlink or FIFO by the time the host prepares the next spawn.
    const hostile = JSON.stringify({ autoMemoryEnabled: true, env: {}, hooks: {} }, null, 2) + '\n';

    it('refuses a symlink to a host file: nothing read, nothing written through it', async () => {
      const ag = await makeGroupLocal('ag-settings-link');
      await initGroupFilesystem(ag, {});
      const claudeDir = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
      const settingsFile = path.join(claudeDir, 'settings.json');
      const hostFile = path.join(TEST_ROOT, 'host-settings.json');
      fs.writeFileSync(hostFile, hostile);
      fs.rmSync(settingsFile);
      fs.symlinkSync(hostFile, settingsFile);

      await initGroupFilesystem(ag, {}); // next spawn

      expect(fs.readFileSync(hostFile, 'utf-8')).toBe(hostile);
      expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Claude settings'),
        expect.objectContaining({ settingsFile }),
      );
    });

    it('does not create a host file through a dangling symlink', async () => {
      const ag = await makeGroupLocal('ag-settings-dangling');
      await initGroupFilesystem(ag, {});
      const settingsFile = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
      const hostFile = path.join(TEST_ROOT, 'never-created.json');
      fs.rmSync(settingsFile);
      fs.symlinkSync(hostFile, settingsFile);

      await initGroupFilesystem(ag, {});

      expect(fs.existsSync(hostFile)).toBe(false);
      expect(fs.lstatSync(settingsFile).isSymbolicLink()).toBe(true);
    });

    it('refuses a FIFO without blocking the spawn', async () => {
      const ag = await makeGroupLocal('ag-settings-fifo');
      await initGroupFilesystem(ag, {});
      const settingsFile = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'settings.json');
      fs.rmSync(settingsFile);
      execFileSync('mkfifo', [settingsFile]);

      await initGroupFilesystem(ag, {});

      expect(fs.lstatSync(settingsFile).isFIFO()).toBe(true);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('Claude settings'),
        expect.objectContaining({ settingsFile }),
      );
    });
  });

  it('stages the same provider-neutral instructions for a provider with its own surfaces', async () => {
    const ag = group('ag-surfy', 'surfy-group');
    await createAgentGroup(ag);

    await initGroupFilesystem(ag, { instructions: 'hello', provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    const sessionRoot = path.join(DATA_DIR, 'v2-sessions', ag.id);
    expect(fs.existsSync(groupDir)).toBe(true);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
    expect(fs.readFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'utf-8')).toBe('hello\n');
    expect(fs.existsSync(path.join(sessionRoot, '.claude-shared'))).toBe(false);
  });

  it('writes nothing at all for a surfaces-owning provider without instructions', async () => {
    const ag = group('ag-surfy-bare', 'surfy-bare-group');
    await createAgentGroup(ag);

    await initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, PERSONA_PREPEND_FILE))).toBe(false);
  });

  it('treats an unregistered provider name as default support files without creating memory', async () => {
    const ag = group('ag-unknown', 'unknown-group');
    await createAgentGroup(ag);

    await initGroupFilesystem(ag, { provider: 'not-registered' });

    const groupDir = path.join(GROUPS_DIR, ag.folder);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });
});

describe('initGroupFilesystem legacy seed isolation', () => {
  it('leaves .seed.md untouched for the manual migration workflow', async () => {
    const ag = group('ag-seed', 'seed-group');
    await createAgentGroup(ag);
    const groupDir = path.join(GROUPS_DIR, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, '.seed.md'), 'seeded identity\n');

    await initGroupFilesystem(ag, {});

    expect(fs.readFileSync(path.join(groupDir, '.seed.md'), 'utf-8')).toBe('seeded identity\n');
    expect(fs.existsSync(path.join(groupDir, PERSONA_PREPEND_FILE))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'CLAUDE.local.md'))).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'memory'))).toBe(false);
  });
});

describe('buildMounts agent surfaces', () => {
  it('fails fast when a declared provider requires a missing legacy adapter', async () => {
    const ag = group('ag-partial-install', 'partial-install');
    await expect(
      resolveProviderContribution(session('partial-session', ag.id), ag, {
        ...containerConfig(),
        provider: 'partial-install-provider',
      }),
    ).rejects.toThrow("Provider 'partial-install-provider' host contract requires a legacy host adapter");
  });

  it('runs an undeclared old payload exactly once on new core', async () => {
    const ag = group('ag-old-payload', 'old-payload');
    const sess = session('old-session', ag.id);
    const resolved = await resolveProviderContribution(sess, ag, {
      ...containerConfig(),
      provider: 'old-payload-provider',
    });

    expect(oldPayloadContribution).toHaveBeenCalledOnce();
    expect(resolved).toMatchObject({
      provider: 'old-payload-provider',
      contribution: { env: { COMPAT: 'legacy' } },
    });
    expect(resolved.surfaces).toBeUndefined();
  });

  it('realizes declared Claude surfaces identically to the legacy default path', async () => {
    const declared = group('ag-declared-claude', 'declared-claude');
    const legacy = group('ag-legacy-default', 'legacy-default');
    await createAgentGroup(declared);
    await createAgentGroup(legacy);
    await ensureContainerConfig(declared.id);
    await ensureContainerConfig(legacy.id);
    await initGroupFilesystem(declared, { provider: 'claude' });
    await initGroupFilesystem(legacy, { provider: 'not-registered' });

    const config = { ...containerConfig(), skills: ['welcome'] };
    const declaredMounts = await buildMounts(declared, session('declared-session', declared.id), config, 'claude', {});
    const legacyMounts = await buildMounts(legacy, session('legacy-session', legacy.id), config, 'not-registered', {});
    const normalize = (value: string): string =>
      value
        .replaceAll(declared.id, '<group>')
        .replaceAll(legacy.id, '<group>')
        .replaceAll(declared.folder, '<folder>')
        .replaceAll(legacy.folder, '<folder>')
        .replaceAll('declared-session', '<session>')
        .replaceAll('legacy-session', '<session>');
    const normalizeMounts = (mounts: typeof declaredMounts) =>
      mounts.map((mount) => ({ ...mount, hostPath: normalize(mount.hostPath), scope: normalize(mount.scope ?? '') }));

    expect(normalizeMounts(declaredMounts)).toEqual(normalizeMounts(legacyMounts));
    expect(fs.readFileSync(path.join(GROUPS_DIR, declared.folder, 'CLAUDE.md'), 'utf-8')).toBe(
      fs.readFileSync(path.join(GROUPS_DIR, legacy.folder, 'CLAUDE.md'), 'utf-8'),
    );

    for (const ag of [declared, legacy]) {
      const state = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared');
      expect(fs.readFileSync(path.join(state, 'settings.json'), 'utf-8')).toBe(
        fs.readFileSync(path.join(DATA_DIR, 'v2-sessions', declared.id, '.claude-shared', 'settings.json'), 'utf-8'),
      );
      expect(fs.lstatSync(path.join(state, 'skills', 'welcome')).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(state, 'skills', 'welcome'))).toBe('/app/skills/welcome');
    }
  });

  it('refuses a symlinked .claude-shared/skills directory exactly as the legacy path does', async () => {
    const declared = group('ag-declared-symlink', 'declared-symlink');
    const legacy = group('ag-legacy-symlink', 'legacy-symlink');
    await createAgentGroup(declared);
    await createAgentGroup(legacy);
    await ensureContainerConfig(declared.id);
    await ensureContainerConfig(legacy.id);
    await initGroupFilesystem(declared, { provider: 'claude' });
    await initGroupFilesystem(legacy, { provider: 'not-registered' });

    // A symlink in place of the skills directory. The container can write
    // there, so the host cannot tell an operator's link from an agent's.
    const relocated = new Map<string, string>();
    for (const ag of [declared, legacy]) {
      const skills = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills');
      const target = path.join(TEST_ROOT, 'relocated', ag.id, 'skills');
      fs.rmSync(skills, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      fs.symlinkSync(target, skills);
      relocated.set(ag.id, target);
    }

    const config = { ...containerConfig(), skills: ['welcome'] };
    const declaredMounts = await buildMounts(declared, session('declared-session', declared.id), config, 'claude', {});
    const legacyMounts = await buildMounts(legacy, session('legacy-session', legacy.id), config, 'not-registered', {});
    const normalize = (value: string): string =>
      value
        .replaceAll(declared.id, '<group>')
        .replaceAll(legacy.id, '<group>')
        .replaceAll(declared.folder, '<folder>')
        .replaceAll(legacy.folder, '<folder>')
        .replaceAll('declared-session', '<session>')
        .replaceAll('legacy-session', '<session>');
    const normalizeMounts = (mounts: typeof declaredMounts) =>
      mounts.map((mount) => ({ ...mount, hostPath: normalize(mount.hostPath), scope: normalize(mount.scope ?? '') }));

    expect(normalizeMounts(declaredMounts)).toEqual(normalizeMounts(legacyMounts));
    for (const ag of [declared, legacy]) {
      const skills = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills');
      expect(fs.lstatSync(skills).isSymbolicLink()).toBe(true);
      // Nothing was written through the symlink.
      expect(fs.readdirSync(relocated.get(ag.id)!)).toEqual([]);
    }
    expect(log.warn).toHaveBeenCalledWith(
      'Shared skills not synced: unsafe skills directory',
      expect.objectContaining({ path: expect.stringContaining('skills') }),
    );
  });

  it('materializes the Claude surface access contract', async () => {
    const ag = group('ag-mounts-default', 'mounts-default');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await initGroupFilesystem(ag, {});

    const mounts = await buildMounts(ag, session('s1', ag.id), containerConfig(), 'claude', {});

    const byContainerPath = new Map(mounts.map((m) => [m.containerPath, m]));
    expect(byContainerPath.get('/workspace/agent/CLAUDE.md')).toMatchObject({
      hostPath: path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'),
      readonly: true,
    });
    expect(byContainerPath.get('/home/node/.claude')).toMatchObject({
      hostPath: path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared'),
      readonly: false,
    });
    expect(
      mounts
        .filter((mount) => ['/workspace/agent/CLAUDE.md', '/home/node/.claude'].includes(mount.containerPath))
        .map((mount) => mount.containerPath),
    ).toEqual(['/workspace/agent/CLAUDE.md', '/home/node/.claude']);
    // Composer ran: the generated project doc exists on disk.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(true);
  });

  it('suppresses the default surfaces and keeps contributed mounts for a surfaces-providing provider', async () => {
    const ag = group('ag-mounts-surfy', 'mounts-surfy');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await initGroupFilesystem(ag, { provider: 'surfaces-test-provider' });

    const contributed = {
      mounts: [
        {
          hostPath: path.join(GROUPS_DIR, ag.folder),
          containerPath: '/workspace/agent/OWN-DOC.md',
          readonly: true,
        },
      ],
    };
    const config = containerConfig();
    config.additionalMounts = [{ hostPath: path.join(GROUPS_DIR, ag.folder), containerPath: 'operator' }];
    const mounts = await buildMounts(ag, session('s2', ag.id), config, 'surfaces-test-provider', contributed);

    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).not.toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/workspace/agent/CLAUDE.md');
    // Composer did NOT run for this group.
    expect(fs.existsSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'))).toBe(false);
    // Core mounts and the provider's own contribution are intact.
    expect(containerPaths).toContain('/workspace');
    expect(containerPaths).toContain('/workspace/agent');
    expect(containerPaths).toContain('/app/src');
    expect(containerPaths).toContain('/workspace/agent/OWN-DOC.md');
    expect(containerPaths.slice(-2)).toEqual(['/workspace/extra/operator', '/workspace/agent/OWN-DOC.md']);
  });

  it('keeps declared allowlisted surfaces at the former provider slot in derived resource order', async () => {
    const ag = group('ag-ordered-mounts', 'ordered-mounts');
    await createAgentGroup(ag);
    await initGroupFilesystem(ag, { provider: 'ordered-mount-provider' });

    const config = containerConfig();
    config.additionalMounts = [{ hostPath: path.join(GROUPS_DIR, ag.folder), containerPath: 'operator' }];
    const sess = session('ordered-mount-session', ag.id);
    const resolved = await resolveProviderContribution(sess, ag, {
      ...config,
      provider: 'ordered-mount-provider',
    });
    const mounts = await buildMounts(ag, sess, config, resolved.provider, resolved.contribution, resolved.surfaces);

    const containerPaths = mounts.map((mount) => mount.containerPath);
    expect(resolved.contribution).toEqual({ env: { COMPAT: 'current' } });
    expect(currentPayloadContribution).toHaveBeenCalledWith(
      expect.objectContaining({ coreOwnsProviderSurfaces: true }),
    );
    expect(new Set(containerPaths).size).toBe(containerPaths.length);
    expect(containerPaths).toEqual([
      '/workspace',
      '/app/.nanoclaw-session.json',
      '/workspace/agent',
      '/workspace/agent/plugins',
      '/app/src',
      '/app/skills',
      '/workspace/extra/operator',
      '/home/node/.codex',
      '/workspace/agent/.agents',
      '/home/node/.agents',
      '/workspace/agent/AGENTS.md',
    ]);
  });
});

describe('derived provider spawn surfaces', () => {
  function backingContract(backing?: ProviderHostContract['skillBackings'][number]): ProviderHostContract {
    return {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: {
        fileName: 'AGENTS.md',
        containerPath: '/workspace/agent/AGENTS.md',
        mountClass: 'group-state',
      },
      stateVolumes: [],
      skillBackings: backing ? [backing] : [],
      skillViews: [],
      files: [],
      commands: { nativeAdmin: [], nativeFiltered: [] },
    };
  }

  it('derives spawn work before composing the project document', async () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: {
        fileName: 'AGENTS.md',
        containerPath: '/workspace/agent/AGENTS.md',
        mountClass: 'group-state',
      },
      stateVolumes: [
        {
          id: 'state',
          directory: '.state',
          containerPath: '/state',
          scope: 'session',
          mode: 'rw',
          mountClass: 'group-state',
        },
      ],
      skillBackings: [
        {
          id: 'skills',
          location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
          skillsSubdirectory: 'skills',
          conflictDiagnostics: 'silent',
          templateCopies: 'in-place',
        },
      ],
      skillViews: [],
      files: [
        {
          id: 'auth',
          volumeId: 'state',
          relativePath: 'auth.json',
          prepare: { operation: 'append-open-close', when: 'every-spawn' },
        },
      ],
      legacyHostAdapter: 'required',
      commands: { nativeAdmin: [], nativeFiltered: [] },
    };
    const groupDir = path.join(GROUPS_DIR, 'ordered-group');
    const sessionDirectory = path.join(DATA_DIR, 'v2-sessions', 'ordered-session');
    const legacyOverlay = vi.fn(async () => ({}));

    await expect(
      realizeProviderSpawnSurfaces('ordered', contract, 'ordered-group', groupDir, sessionDirectory, [], {
        legacyOverlay,
        composeProjectDocument: async () => {
          throw new Error('compose failed');
        },
      }),
    ).rejects.toThrow('compose failed');

    expect(fs.existsSync(path.join(sessionDirectory, '.state', 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(groupDir, '.agents', 'skills'))).toBe(true);
    expect(legacyOverlay).toHaveBeenCalledOnce();
  });

  function appendOpenCloseContract(): ProviderHostContract {
    return {
      ...backingContract(),
      stateVolumes: [
        {
          id: 'state',
          directory: '.state',
          containerPath: '/state',
          scope: 'session',
          mode: 'rw',
          mountClass: 'group-state',
        },
      ],
      files: [
        {
          id: 'auth',
          volumeId: 'state',
          relativePath: 'auth.json',
          prepare: { operation: 'append-open-close', when: 'every-spawn' },
        },
      ],
    };
  }

  /** The refusal must name the file and say how to clear it. */
  function notRegularFileMessage(file: string): RegExp {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${escaped} is not a regular file.*remove it`);
  }

  it('refuses a FIFO planted at an append-open-close file without blocking', () => {
    const sessionDirectory = path.join(DATA_DIR, 'v2-sessions', 'fifo-session');
    const fifo = path.join(sessionDirectory, '.state', 'auth.json');
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    // Run in a child with a timeout: a blocking open would hang this worker
    // instead of failing the test.
    const source = `
      const { realizeProviderSpawnSurfaces } = await import('./src/provider-contracts/realize.ts');
      const [contract, groupDir, sessionDirectory] = process.argv.slice(1);
      try {
        await realizeProviderSpawnSurfaces('fifo', JSON.parse(contract), 'fifo-group', groupDir, sessionDirectory, [], {
          legacyOverlay: async () => ({}),
          composeProjectDocument: async () => {},
        });
        console.log('outcome=resolved');
      } catch (err) {
        console.log('outcome=' + err.message);
      }
    `;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        source,
        JSON.stringify(appendOpenCloseContract()),
        path.join(GROUPS_DIR, 'fifo-group'),
        sessionDirectory,
      ],
      { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.signal, 'prepareSpawnFile blocked on a FIFO').toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(notRegularFileMessage(fifo));
  }, 30_000);

  it('refuses a FIFO at an append-open-close file even while something reads it', async () => {
    const sessionDirectory = path.join(DATA_DIR, 'v2-sessions', 'read-fifo-session');
    const fifo = path.join(sessionDirectory, '.state', 'auth.json');
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    // With a reader present the host's write-open returns at once, so this
    // runs in-process; only the regular-file check can refuse the FIFO.
    const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      await expect(
        realizeProviderSpawnSurfaces(
          'fifo',
          appendOpenCloseContract(),
          'fifo-group',
          path.join(GROUPS_DIR, 'fifo-group'),
          sessionDirectory,
          [],
          { legacyOverlay: async () => ({}), composeProjectDocument: async () => {} },
        ),
      ).rejects.toThrow(notRegularFileMessage(fifo));
    } finally {
      fs.closeSync(reader);
    }
  });

  it('names a symlink planted at an append-open-close file and leaves its target alone', async () => {
    const sessionDirectory = path.join(DATA_DIR, 'v2-sessions', 'link-session');
    const link = path.join(sessionDirectory, '.state', 'auth.json');
    const victim = path.join(TEST_ROOT, 'victim-auth.json');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(victim, 'precious\n');
    fs.symlinkSync(victim, link);

    await expect(
      realizeProviderSpawnSurfaces(
        'link',
        appendOpenCloseContract(),
        'link-group',
        path.join(GROUPS_DIR, 'link-group'),
        sessionDirectory,
        [],
        { legacyOverlay: async () => ({}), composeProjectDocument: async () => {} },
      ),
    ).rejects.toThrow(notRegularFileMessage(link));
    expect(fs.readFileSync(victim, 'utf-8')).toBe('precious\n');
  });

  it('ignores declared legacy callback mounts while retaining env', async () => {
    const realized = await realizeProviderSpawnSurfaces(
      'declared',
      backingContract(),
      'group',
      GROUPS_DIR,
      DATA_DIR,
      [],
      {
        legacyOverlay: async () => ({
          env: { COMPAT: 'yes' },
          mounts: [{ hostPath: GROUPS_DIR, containerPath: '/legacy', readonly: true }],
        }),
        composeProjectDocument: async () => {},
      },
    );
    expect(realized.contribution).toEqual({ env: { COMPAT: 'yes' } });
  });

  it('contains raw contract paths if registration validation is bypassed', async () => {
    const contract = backingContract({
      id: 'skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '../../escape' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      templateCopies: 'in-place',
    });

    await expect(
      realizeProviderSpawnSurfaces('raw', contract, 'group', path.join(TEST_ROOT, 'safe'), DATA_DIR, [], {
        legacyOverlay: async () => ({}),
        composeProjectDocument: async () => {},
      }),
    ).rejects.toThrow(/escapes its resolved root/);
  });

  it.each([
    ['warn', true],
    ['silent', false],
  ] as const)('%s conflict diagnostics control shared-link warnings', async (policy, expectedWarning) => {
    const groupDir = path.join(TEST_ROOT, `conflict-${policy}`);
    fs.mkdirSync(path.join(groupDir, '.agents', 'skills', 'welcome'), { recursive: true });
    const contract = backingContract({
      id: 'skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: policy,
      templateCopies: 'in-place',
    });

    await realizeProviderSpawnSurfaces('conflict', contract, 'group', groupDir, DATA_DIR, ['welcome'], {
      legacyOverlay: async () => ({}),
      composeProjectDocument: async () => {},
    });

    expect(log.warn).toHaveBeenCalledTimes(expectedWarning ? 1 : 0);
    vi.mocked(log.warn).mockClear();
  });

  it('leaves a host directory alone when a state-volume skills dir is a symlink to it', async () => {
    const hostDir = path.join(TEST_ROOT, 'host-outside-skills');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.symlinkSync('/somewhere', path.join(hostDir, 'stale-link'));
    const volumeDir = path.join(DATA_DIR, 'v2-sessions', 'linked-skills', '.linked-state');
    fs.mkdirSync(volumeDir, { recursive: true });
    fs.symlinkSync(hostDir, path.join(volumeDir, 'skills'));
    const contract: ProviderHostContract = {
      ...backingContract({
        id: 'skills',
        location: { kind: 'state-volume', volumeId: 'state', subdirectory: '' },
        skillsSubdirectory: 'skills',
        conflictDiagnostics: 'warn',
        templateCopies: 'in-place',
      }),
      stateVolumes: [
        {
          id: 'state',
          directory: '.linked-state',
          containerPath: '/state',
          scope: 'group',
          mode: 'rw',
          mountClass: 'group-state',
        },
      ],
    };

    await realizeProviderSpawnSurfaces('linked', contract, 'linked-skills', GROUPS_DIR, DATA_DIR, ['welcome'], {
      legacyOverlay: async () => ({}),
      composeProjectDocument: async () => {},
    });

    expect(fs.readdirSync(hostDir)).toEqual(['stale-link']);
    vi.mocked(log.warn).mockClear();
  });

  it('refuses a session-scoped state volume whose own directory is a symlink', async () => {
    const hostDir = path.join(TEST_ROOT, 'host-outside-session');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.symlinkSync('/somewhere', path.join(hostDir, 'stale-link'));
    // The session volume directory itself is swapped for a symlink — the case
    // where the anchor must be the session dir, not the volume directory.
    const sessionDirectory = path.join(DATA_DIR, 'v2-sessions', 'session-linked-vol');
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.symlinkSync(hostDir, path.join(sessionDirectory, '.sess-state'));
    const contract: ProviderHostContract = {
      ...backingContract({
        id: 'skills',
        location: { kind: 'state-volume', volumeId: 'state', subdirectory: '' },
        skillsSubdirectory: 'skills',
        conflictDiagnostics: 'warn',
        templateCopies: 'in-place',
      }),
      stateVolumes: [
        {
          id: 'state',
          directory: '.sess-state',
          containerPath: '/state',
          scope: 'session',
          mode: 'rw',
          mountClass: 'group-state',
        },
      ],
    };

    await realizeProviderSpawnSurfaces('sesslinked', contract, 'g', GROUPS_DIR, sessionDirectory, ['welcome'], {
      legacyOverlay: async () => ({}),
      composeProjectDocument: async () => {},
    });

    expect(fs.readdirSync(hostDir)).toEqual(['stale-link']);
    expect(log.warn).toHaveBeenCalledWith(
      'Shared skills not synced: unsafe skills directory',
      expect.objectContaining({ path: expect.stringContaining('skills') }),
    );
    vi.mocked(log.warn).mockClear();
  });

  it('protects the shipped base document as a core fact, not a contract field', () => {
    // Contracts registered in this file declare other documents (AGENTS.md)
    // and none of them adds to or removes from the protected set.
    expect(protectedProviderDocumentSourcePaths('/install')).toEqual([path.join('/install', 'container', 'CLAUDE.md')]);
  });

  it('labels reconciliation from the transformer provider', () => {
    const contract: ProviderHostContract = {
      ...backingContract(),
      stateVolumes: [
        {
          id: 'state',
          directory: '.diagnostic-state',
          containerPath: '/state',
          scope: 'group',
          mode: 'rw',
          mountClass: 'group-state',
        },
      ],
      files: [
        {
          id: 'settings',
          volumeId: 'state',
          relativePath: 'settings.json',
          prepare: {
            operation: 'create-if-missing',
            when: 'group-init',
            content: '{"old":true}\n',
          },
          reconcile: {
            transformer: 'claude-settings',
            transformerProvider: 'diagnostic-source',
          },
        },
      ],
    };

    initializeProviderGroupSurfaces('consumer', contract, 'diagnostic-group', GROUPS_DIR);
    expect(initializeProviderGroupSurfaces('consumer', contract, 'diagnostic-group', GROUPS_DIR)).toContain(
      'settings.json (reconciled Diagnostic-source settings)',
    );
  });
});

// An installed but unselected gateway: its agent skill must never reach a
// container. Registered for the whole file but never selected: the suite below
// pins the selection to its 'fixture' gateway.
registerGatewayProvider({
  kind: 'inactive-fixture',
  agentSkills: ['inactive-gateway'],
  sessions: { ensure: async () => ({ contribution: {} }) },
  approvals: { subscribe: async () => {} },
} as unknown as Parameters<typeof registerGatewayProvider>[0]);

describe('spawn-path project document skill selection', () => {
  const REPO_ROOT = process.cwd();
  let previousGateway: ReturnType<typeof getGatewayProvider>;

  beforeEach(() => {
    previousGateway = getGatewayProvider();
    // A source tree holding two gateways' agent skills, each carrying the
    // resident prose a credential prohibition lives in.
    const sourceRoot = path.join(TEST_ROOT, 'source');
    for (const [skill, prose] of [
      ['fixture-gateway', 'Fixture credential guidance.'],
      ['inactive-gateway', 'Inactive gateway guidance.'],
    ]) {
      const skillDir = path.join(sourceRoot, 'container', 'skills', skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
      fs.writeFileSync(path.join(skillDir, 'instructions.md'), prose);
    }
    for (const entry of ['CLAUDE.md', 'agent-runner']) {
      fs.symlinkSync(path.join(REPO_ROOT, 'container', entry), path.join(sourceRoot, 'container', entry));
    }
    process.chdir(sourceRoot);
    resetGatewayProvider({
      kind: 'fixture',
      agentSkills: ['fixture-gateway'],
      sessions: { ensure: async () => ({ contribution: {} }) },
      approvals: { subscribe: async () => {} },
    } as unknown as Parameters<typeof resetGatewayProvider>[0]);
  });

  afterEach(() => {
    process.chdir(REPO_ROOT);
    resetGatewayProvider(previousGateway);
  });

  // Red if the contract path composes from the stored selection: the active
  // gateway's skill is linked but its resident prose is missing, and the
  // inactive gateway's prose is composed though its skill is not linked.
  it('composes the gateway-adjusted selection the skill links follow, not the stored one', async () => {
    const ag = group('ag-narrow-skills', 'narrow-skills');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    await updateContainerConfigJson(ag.id, 'skills', ['inactive-gateway']);
    await initGroupFilesystem(ag, { provider: 'claude' });

    // The spawn order: surfaces realized once, then handed to buildMounts.
    const config = { ...containerConfig(), skills: ['inactive-gateway'] };
    const sess = session('narrow-session', ag.id);
    const { provider, contribution, surfaces } = await resolveProviderContribution(sess, ag, config);
    expect(surfaces).toBeDefined();
    await buildMounts(ag, sess, config, provider, contribution, surfaces);

    const skills = path.join(DATA_DIR, 'v2-sessions', ag.id, '.claude-shared', 'skills');
    expect(fs.readlinkSync(path.join(skills, 'fixture-gateway'))).toBe('/app/skills/fixture-gateway');
    // Links target container paths, dangling on the host: check the entry itself.
    expect(fs.readdirSync(skills)).not.toContain('inactive-gateway');
    const doc = fs.readFileSync(path.join(GROUPS_DIR, ag.folder, 'CLAUDE.md'), 'utf-8');
    expect(doc).toContain('# NanoClaw Skill: fixture-gateway');
    expect(doc).toContain('Fixture credential guidance.');
    expect(doc).not.toContain('# NanoClaw Skill: inactive-gateway');
    expect(doc).not.toContain('Inactive gateway guidance.');
  });
});
