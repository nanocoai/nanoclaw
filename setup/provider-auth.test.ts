import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  image: 'local',
  confirm: true as boolean | symbol,
  installed: true,
  changed: true,
  offline: false,
  installModes: [] as unknown[],
  build: { ok: true } as { ok: boolean; message?: string },
  blockers: [] as string[],
  auth: vi.fn(async () => {}),
  check: vi.fn(async () => {}),
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => {
  const entry = (name = 'opencode') => ({
    value: name,
    runAuth: async () => {
      fixture.order.push('auth');
      await fixture.auth();
    },
    runInstallCheck: fixture.check,
  });
  return {
    getSetupProvider: (name: string) => (fixture.installed ? entry(name) : undefined),
    listSetupProviders: () => (fixture.installed ? [entry()] : []),
  };
});
// Use a tracked module for this sequencing fixture so the mock resolves even
// before optional provider payloads have been installed in a clean checkout.
vi.mock('./providers/claude.js', () => {
  fixture.installed = true;
  fixture.order.push('load-adapter');
  return {};
});
vi.mock('./providers/skill-descriptor.js', () => ({
  getInstallableProviderDescriptor: () => ({ skillDir: '.claude/skills/add-opencode' }),
  providerImagePolicy: () => 'local-required',
}));
vi.mock('./providers/install.js', () => ({
  applyProviderSkill: async (_skill: string, _root: string, options?: unknown) => {
    fixture.order.push('install');
    fixture.installModes.push(options);
    if (fixture.offline) throw new Error('Registry and build dependencies are unavailable');
    return { changed: fixture.changed, blockers: fixture.blockers };
  },
}));
vi.mock('./lib/container-build.js', () => ({
  buildContainerImage: () => {
    fixture.order.push('build');
    return fixture.build;
  },
}));
vi.mock('./lib/registry-state.js', () => ({
  HARDENED_IMAGE_ENV_KEY: 'NANOCLAW_HARDENED_IMAGE',
  readImageSource: () => fixture.image,
  writeImageSource: () => {
    fixture.order.push('local-image');
    fixture.image = 'local';
  },
}));
vi.mock('@clack/prompts', () => ({
  confirm: async () => fixture.confirm,
  isCancel: (value: unknown) => typeof value === 'symbol',
}));
import { run } from './provider-auth.js';

beforeEach(() => {
  Object.assign(fixture, {
    order: [],
    image: 'local',
    confirm: true,
    installed: true,
    changed: true,
    offline: false,
    installModes: [],
    build: { ok: true },
    blockers: [],
  });
  fixture.auth.mockClear();
  fixture.check.mockClear();
  vi.stubEnv('NANOCLAW_HARDENED_IMAGE', undefined);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('setup stopped');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('standalone provider setup flow', () => {
  it.each(['codex', 'opencode'])(
    'authenticates installed %s without installation, rebuilding, or an image-mode change',
    async (provider) => {
      fixture.image = 'hardened';
      fixture.offline = true;
      await run([provider]);
      expect(fixture.order).toEqual(['auth']);
      expect(fixture.check).toHaveBeenCalledTimes(1);
    },
  );

  it('loads the setup adapter after a fresh installation and successful image build', async () => {
    fixture.installed = false;
    await run(['claude']);
    expect(fixture.order).toEqual(['install', 'build', 'load-adapter', 'auth']);
    expect(fixture.installModes).toEqual([{ mode: 'install' }]);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });
  it('resolves a local image before payload changes, then builds before auth', async () => {
    fixture.image = 'hardened';
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['local-image', 'install', 'build', 'auth']);
    expect(fixture.installModes).toEqual([{ mode: 'refresh' }]);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });
  it('leaves the payload untouched when the image decision is declined or cancelled', async () => {
    fixture.image = 'hardened';
    for (const answer of [false, Symbol('cancel')]) {
      fixture.confirm = answer;
      await expect(run(['opencode', '--refresh'])).rejects.toThrow('cancelled');
      expect(fixture.order).toEqual([]);
    }
  });
  it('rejects an exported image override before payload changes', async () => {
    fixture.image = 'hardened';
    vi.stubEnv('NANOCLAW_HARDENED_IMAGE', 'true');
    await expect(run(['opencode', '--refresh'])).rejects.toThrow('Unset exported');
    expect(fixture.order).toEqual([]);
  });
  it('does not authenticate when installation or image building fails', async () => {
    fixture.blockers = ['incompatible core'];
    await expect(run(['opencode', '--refresh'])).rejects.toThrow('setup stopped');
    expect(fixture.order).toEqual(['install']);
    fixture.blockers = [];
    fixture.order = [];
    fixture.build = { ok: false, message: 'fixture build failed' };
    await expect(run(['opencode', '--refresh'])).rejects.toThrow('setup stopped');
    expect(fixture.order).toEqual(['install', 'build']);
    expect(fixture.auth).not.toHaveBeenCalled();
  });
  it('does not rebuild when applying a skill made no image changes', async () => {
    fixture.changed = false;
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['install', 'auth']);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });
});
