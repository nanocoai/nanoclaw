import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  order: [] as string[],
  image: 'local',
  confirm: true as boolean | symbol,
  installed: true,
  changed: true,
  hostChanged: true,
  offline: false,
  installModes: [] as unknown[],
  build: { ok: true } as { ok: boolean; message?: string },
  restart: { status: 'restarted' } as { status: string; message?: string },
  hostSettings: '',
  blockers: [] as string[],
  contractModules: [] as string[],
  loadedContractModules: [] as string[],
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
    return {
      changed: fixture.changed,
      hostChanged: fixture.hostChanged,
      blockers: fixture.blockers,
      hostContractModules: fixture.contractModules,
    };
  },
  loadHostContractModules: async (modules: string[]) => {
    fixture.order.push('load-contracts');
    fixture.loadedContractModules.push(...modules);
  },
}));
vi.mock('./lib/container-build.js', () => ({
  buildContainerImage: () => {
    fixture.order.push('build');
    return fixture.build;
  },
}));
vi.mock('./lib/host-restart.js', () => ({
  HOST_RESTART_COMMAND: 'pnpm run build && bash setup/lib/restart.sh',
  restartHost: () => {
    fixture.order.push('restart-host');
    return fixture.restart;
  },
  readHostSettings: () => fixture.hostSettings,
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
    hostChanged: true,
    offline: false,
    installModes: [],
    build: { ok: true },
    restart: { status: 'restarted' },
    hostSettings: 'OTHER=keep\n',
    blockers: [],
    contractModules: [],
    loadedContractModules: [],
  });
  fixture.auth.mockClear();
  fixture.check.mockClear();
  vi.stubEnv('NANOCLAW_HARDENED_IMAGE', undefined);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('setup stopped');
  });
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('standalone provider setup flow', () => {
  it.each(['codex', 'opencode'])(
    'authenticates installed %s without installation, rebuilding, a host restart, or an image-mode change',
    async (provider) => {
      fixture.image = 'hardened';
      fixture.offline = true;
      await run([provider]);
      expect(fixture.order).toEqual(['auth']);
      expect(fixture.check).toHaveBeenCalledTimes(1);
    },
  );

  // The contract barrel is in this process's ESM cache from startup, so
  // the module the install appended is imported directly, after the rebuild
  // and before the payload's auth step asks the gateway store for endpoints.
  it('loads the host contract and the setup adapter after a fresh installation and image build', async () => {
    fixture.installed = false;
    fixture.contractModules = ['/install/src/provider-contracts/claude.ts'];
    await run(['claude']);
    expect(fixture.order).toEqual(['install', 'build', 'restart-host', 'load-contracts', 'load-adapter', 'auth']);
    expect(fixture.loadedContractModules).toEqual(['/install/src/provider-contracts/claude.ts']);
    expect(fixture.installModes).toEqual([{ mode: 'install' }]);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });
  it('persists the local image choice after successful apply, then builds before auth', async () => {
    fixture.image = 'hardened';
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['install', 'local-image', 'build', 'restart-host', 'load-contracts', 'auth']);
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
  it.each(['blocked', 'throws'])('preserves hardened image selection when provider apply %s', async (failure) => {
    fixture.image = 'hardened';
    fixture.blockers = failure === 'blocked' ? ['incompatible core'] : [];
    fixture.offline = failure === 'throws';
    await expect(run(['opencode', '--refresh'])).rejects.toThrow(
      failure === 'blocked' ? 'setup stopped' : 'Registry and build dependencies are unavailable',
    );
    expect(fixture.image).toBe('hardened');
    expect(fixture.order).toEqual(['install']);
    expect(fixture.auth).not.toHaveBeenCalled();
    expect(fixture.check).not.toHaveBeenCalled();
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
  it('neither rebuilds nor restarts when applying the skill changed nothing', async () => {
    fixture.changed = false;
    fixture.hostChanged = false;
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['install', 'load-contracts', 'auth']);
    expect(fixture.check).toHaveBeenCalledTimes(1);
  });

  // The service runs the host build it loaded at start, so a payload that
  // changed host code is invisible to it until a rebuild and restart. It
  // restarts before auth because a failed sign-in exits the process, and a
  // re-run only re-authenticates. The fresh-install order is pinned above.
  it('restarts the host once, after the image build and before auth, when a refresh changed host code', async () => {
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['install', 'build', 'restart-host', 'load-contracts', 'auth']);
    expect(fixture.installModes).toEqual([{ mode: 'refresh' }]);
    expect(process.exitCode).toBeUndefined();
  });
  // OpenCode saves its endpoint to .env during auth, and its host contract
  // reads the endpoint only at start.
  it('restarts again after auth only when auth changed the settings the host reads at start', async () => {
    fixture.auth.mockImplementationOnce(async () => {
      fixture.hostSettings = 'OTHER=keep\nOPENCODE_BASE_URL=http://host.docker.internal:11434/v1\n';
    });
    fixture.check.mockImplementationOnce(async () => {
      fixture.order.push('check');
    });
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual([
      'install',
      'build',
      'restart-host',
      'load-contracts',
      'auth',
      'check',
      'restart-host',
    ]);
  });
  // Re-authenticating an installed provider can save a new endpoint; the
  // running host still holds the old one until it restarts.
  it('restarts after a re-auth that changed the settings the host reads at start', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.auth.mockImplementationOnce(async () => {
      fixture.hostSettings = 'OPENCODE_BASE_URL=native\n';
    });
    await run(['opencode']);
    expect(fixture.order).toEqual(['auth', 'restart-host']);
    expect(process.exitCode).toBeUndefined();
    // Running agent containers keep the settings they started with.
    expect(log.mock.calls.flat().join('\n')).toContain('bin/ncl groups restart --id');
  });
  it('does not restart a re-auth that left those settings unchanged', async () => {
    await run(['opencode']);
    expect(fixture.order).toEqual(['auth']);
  });
  it('says so, without failing, when a re-auth changed settings and no service is installed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.restart = { status: 'no-service' };
    fixture.auth.mockImplementationOnce(async () => {
      fixture.hostSettings = 'OPENCODE_BASE_URL=native\n';
    });
    await run(['opencode']);
    expect(fixture.order).toEqual(['auth', 'restart-host']);
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('No NanoClaw service is installed');
    // A host run by hand may still hold agents; that clause rides in the same message.
    expect(out).toContain('bin/ncl groups restart --id');
    expect(out).not.toContain('Agents already running');
    expect(process.exitCode).toBeUndefined();
  });
  // tsc can emit dist/ despite errors, so a failed build is never restarted onto.
  it('keeps the running host on a failed build after a re-auth, with the credential saved', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fixture.restart = { status: 'failed', message: 'pnpm run build exited 2' };
    fixture.auth.mockImplementationOnce(async () => {
      fixture.hostSettings = 'OPENCODE_BASE_URL=native\n';
    });
    await run(['opencode']);
    expect(fixture.order).toEqual(['auth', 'restart-host']);
    expect(error.mock.calls[0][0]).toContain('pnpm run build && bash setup/lib/restart.sh');
    expect(process.exitCode).toBe(1);
  });
  // What counts as a host change is applyProviderSkill's call (install.test.ts).
  it('rebuilds the image but leaves the host alone when the apply changed no host files', async () => {
    fixture.hostChanged = false;
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['install', 'build', 'load-contracts', 'auth']);
  });
  it('still authenticates when the restart fails, prints the command once, and exits non-zero', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fixture.restart = { status: 'failed', message: 'restart.sh exited 1' };
    fixture.auth.mockImplementationOnce(async () => {
      fixture.hostSettings = 'OPENCODE_BASE_URL=native\n';
    });
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['install', 'build', 'restart-host', 'load-contracts', 'auth']);
    expect(fixture.check).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('pnpm run build && bash setup/lib/restart.sh');
    expect(process.exitCode).toBe(1);
  });
  // Installing before the service step: no host runs yet, and the service
  // step starts the build this run already made.
  it('treats a missing service as nothing to restart, not a failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    fixture.restart = { status: 'no-service' };
    fixture.auth.mockImplementationOnce(async () => {
      fixture.hostSettings = 'OPENCODE_BASE_URL=native\n';
    });
    await run(['opencode', '--refresh']);
    expect(fixture.order).toEqual(['install', 'build', 'restart-host', 'load-contracts', 'auth']);
    expect(error).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain('pnpm exec tsx setup/index.ts --step service');
    expect(process.exitCode).toBeUndefined();
  });
});
