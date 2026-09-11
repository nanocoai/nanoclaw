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
import { ensureContainerConfig } from './db/container-configs.js';
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

  it('follows a symlinked .claude-shared/skills directory exactly as the legacy path does', async () => {
    const declared = group('ag-declared-symlink', 'declared-symlink');
    const legacy = group('ag-legacy-symlink', 'legacy-symlink');
    await createAgentGroup(declared);
    await createAgentGroup(legacy);
    await ensureContainerConfig(declared.id);
    await ensureContainerConfig(legacy.id);
    await initGroupFilesystem(declared, { provider: 'claude' });
    await initGroupFilesystem(legacy, { provider: 'not-registered' });

    // Operator relocated the skills directory and left a symlink in its place.
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
      // The link was written through the symlink into the relocated directory.
      const link = path.join(relocated.get(ag.id)!, 'welcome');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe('/app/skills/welcome');
    }
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
