import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process so runCodexLoginAuth never spawns a real codex CLI; the
// spawn stand-in plays `codex login` writing auth.json into whatever
// CODEX_HOME it was handed.
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Keep the auth flow's structured logging out of logs/setup.log.
vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

// The API-key path reads the key through clack's masked prompt; everything
// else in the module keeps the real clack rendering.
const mockPassword = vi.fn();
const mockConfirm = vi.fn();
vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  password: (...args: unknown[]) => mockPassword(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

import * as setupLog from '../logs.js';
import {
  buildCodexFailurePrompt,
  offerCodexFailureAssist,
  resolveCodexCli,
  runCodexApiKeyAuth,
  runCodexInstallCheck,
  runCodexLoginAuth,
  storeFailureMessage,
  verifyCodexInstall,
} from './codex.js';

// Structural guard for the codex payload wiring: provider files, both barrel
// imports, and the pinned Dockerfile install. Goes red if any of them is
// removed without going through the /add-codex (or its REMOVE.md) path.
describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-complete-check-'));
    try {
      for (const file of [
        'src/providers/codex.ts',
        'src/providers/codex-agents-md.ts',
        'container/agent-runner/src/providers/codex.ts',
        'container/agent-runner/src/providers/codex-app-server.ts',
        'src/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
      ]) {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "import './codex.js';\n");
      }
      fs.writeFileSync(path.join(root, 'container/cli-tools.json'), JSON.stringify([{ name: '@openai/codex' }]));
      expect(verifyCodexInstall(root)).toEqual({ ok: true, problems: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks setup when the payload is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-check-'));
    try {
      await expect(runCodexInstallCheck(root)).rejects.toThrow(/Codex provider is not fully installed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Pure prompt builder for the failure-assist hook — no spawning involved.
describe('buildCodexFailurePrompt', () => {
  it('carries the failure context and the de-duped reference list', () => {
    const projectRoot = '/repo';
    const prompt = buildCodexFailurePrompt(
      {
        stepName: 'verify',
        msg: 'first-chat ping timed out',
        hint: 'check the container logs',
        rawLogPath: '/repo/logs/setup-steps/verify.log',
      },
      projectRoot,
    );

    expect(prompt).toContain('Failed step: verify');
    expect(prompt).toContain('Error: first-chat ping timed out');
    expect(prompt).toContain('Hint: check the container logs');
    expect(prompt).toContain('README.md'); // BIG_PICTURE_FILES
    expect(prompt).toContain('setup/verify.ts'); // STEP_FILES['verify']
    expect(prompt).toContain('logs/setup.log');
    expect(prompt).toContain('logs/setup-steps/verify.log'); // relativized rawLogPath
  });

  it('falls back to the step-log directory when no raw log path is given', () => {
    const prompt = buildCodexFailurePrompt({ stepName: 'verify', msg: 'boom' }, '/repo');
    expect(prompt).toContain('logs/setup-steps/');
    expect(prompt).not.toContain('Hint:');
  });
});

describe('offerCodexFailureAssist', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockSpawn.mockReset();
    mockSpawnSync.mockReset();
    mockConfirm.mockReset();
  });

  it('launches Codex read-only with approval on request', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-assist-home-'));
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
      vi.stubEnv('HOME', home);
      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'codex-cli 0.169.0' });
      mockConfirm.mockResolvedValue(true);
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 0));
        return child;
      });

      expect(await offerCodexFailureAssist({ stepName: 'gateway', msg: 'boom' }, '/repo')).toBe('launched');

      const [binary, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(binary).toBe('codex');
      expect(args.slice(0, 4)).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request']);
      expect(args).toHaveLength(5);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// Session-isolation invariant: the ChatGPT session vaulted for the gateway
// must never be the user's personal ~/.codex session — sharing one OAuth
// session across two consumers gets the whole family invalidated server-side
// when refresh tokens rotate (see the header of codex.ts).
describe('runCodexLoginAuth', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-root-'));
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    mockSpawn.mockReset();
    mockSpawnSync.mockReset();
    vi.restoreAllMocks();
  });

  /** Plays `codex login`: records its env and its home's mode, writes auth.json. */
  function playLogin(): { env: () => NodeJS.ProcessEnv | undefined; mode: () => number | undefined } {
    let env: NodeJS.ProcessEnv | undefined;
    let mode: number | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      env = (args[2] as { env?: NodeJS.ProcessEnv }).env;
      mode = fs.statSync(env!.CODEX_HOME!).mode & 0o777;
      fs.writeFileSync(path.join(env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    return { env: () => env, mode: () => mode };
  }

  it('logs in under an isolated CODEX_HOME, vaults from it, and deletes it', async () => {
    const login = playLogin();
    const save = vi.fn(async (_provider, credential) => {
      expect(fs.existsSync(credential.file)).toBe(true);
    });
    await runCodexLoginAuth('browser', { has: async () => false, save }, root);

    // The login spawn ran under a CODEX_HOME that is not the personal one.
    const codexHome = login.env()?.CODEX_HOME;
    expect(codexHome).toBeDefined();
    expect(codexHome).not.toBe(path.join(os.homedir(), '.codex'));

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    expect(save).toHaveBeenCalledWith('codex', { kind: 'oauth', file: path.join(codexHome!, 'auth.json') });

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);

    // A host codex that runs is used as is; npx never comes into it.
    expect(mockSpawn.mock.calls[0].slice(0, 2)).toEqual(['codex', ['login']]);
    expect(mockSpawnSync.mock.calls.map((call: unknown[]) => call[0])).toEqual(['codex']);
  });

  // #4449: Codex won't set up its helper binaries under the system temp dir
  // and warns on every sign-in, so the home lives in the install's data/.
  it('keeps the throwaway home private, under data/codex-login', async () => {
    const login = playLogin();
    const listeners = () => ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map((event) => process.listenerCount(event));
    const before = listeners();
    await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);

    // The cleanup hooks last only as long as the sign-in.
    expect(listeners()).toEqual(before);

    const base = path.join(root, 'data', 'codex-login');
    expect(path.dirname(login.env()!.CODEX_HOME!)).toBe(base);
    expect(login.mode()).toBe(0o700);
    expect(fs.statSync(base).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('removes a home that a killed sign-in left over an hour ago, and keeps a newer one', async () => {
    const base = path.join(root, 'data', 'codex-login');
    const stale = path.join(base, 'login-stale');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'auth.json'), '{}');
    fs.mkdirSync(path.join(base, 'login-recent'));
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
    playLogin();

    await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);

    expect(fs.readdirSync(base)).toEqual(['login-recent']);
  });

  // Ctrl-C and a hangup reach the whole terminal job; a signal sent to setup
  // alone reaches only setup, which stops the login before removing its home.
  it.each(['SIGTERM', 'SIGHUP'] as const)(
    'on %s stops the login, then removes the home and re-raises the signal',
    async (signal) => {
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
      vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('setup stopped');
      }) as typeof process.exit);
      const listeners = () => ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map((event) => process.listeners(event));
      const before = listeners();
      const runnerOwn = process.listeners(signal);
      let home: string | undefined;
      let homeWhileStopping: boolean | undefined;
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => {
          // Still there while the login shuts down, until it closes.
          setImmediate(() => {
            homeWhileStopping = fs.existsSync(home!);
            child.emit('close', null);
          });
          return true;
        }),
      });
      mockSpawn.mockImplementation((...args: unknown[]) => {
        home = (args[2] as { env?: NodeJS.ProcessEnv }).env!.CODEX_HOME;
        // Deliver it to the login's own handler only, not the test runner's.
        const added = process.listeners(signal).filter((listener) => !runnerOwn.includes(listener));
        setImmediate(() => added.forEach((listener) => (listener as (s: NodeJS.Signals) => void)(signal)));
        return child;
      });

      await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
        'setup stopped',
      );

      // npm passes SIGTERM on to codex, but not SIGHUP.
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(homeWhileStopping).toBe(true);
      expect(kill).toHaveBeenCalledWith(process.pid, signal);
      expect(fs.existsSync(home!)).toBe(false);
      expect(listeners()).toEqual(before);
    },
  );
});

// #3791: a host without `codex` runs the image's pinned CLI through npx
// instead of asking for a global install, which fails for users without
// write access to the npm prefix.
describe('runCodexLoginAuth without a host Codex CLI', () => {
  const NPX_PREFIX = ['--yes', '--ignore-scripts', '--loglevel=error', '--package', '@openai/codex@0.169.0', '-c'];
  const PINNED_INSTALL = [
    'curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release 0.169.0',
    'npm install -g @openai/codex@0.169.0',
  ];
  const enoent = (cmd: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: 'ENOENT' });

  let root: string;
  let scratch: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-npx-root-'));
    fs.mkdirSync(path.join(root, 'container'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-npx-scratch-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
    mockSpawn.mockReset();
    mockSpawnSync.mockReset();
    vi.mocked(setupLog.step).mockClear();
    vi.restoreAllMocks();
  });

  function writeManifest(tools: unknown): void {
    fs.writeFileSync(path.join(root, 'container', 'cli-tools.json'), JSON.stringify(tools));
  }

  /** `codex` is not on PATH; `npx` behaves as given. Records what npx's cwd held. */
  function hostWithoutCodex(npx: { status: number | null; error?: Error; stderr?: string }): {
    npxProject: () => string | undefined;
  } {
    let npxProject: string | undefined;
    mockSpawnSync.mockImplementation((cmd: string, _args: string[], opts: { cwd?: string }) => {
      if (cmd === 'codex') return { status: null, stdout: '', stderr: '', error: enoent('codex') };
      if (cmd === 'npx') {
        npxProject = fs.readFileSync(path.join(opts.cwd!, 'package.json'), 'utf-8');
        return { status: npx.status, stdout: 'codex-cli 0.169.0\n', stderr: npx.stderr ?? '', error: npx.error };
      }
      throw new Error(`unexpected spawnSync ${cmd}`);
    });
    return { npxProject: () => npxProject };
  }

  /** The CODEX_HOME every `--version` probe ran under. */
  function probeHomes(): Array<string | undefined> {
    return mockSpawnSync.mock.calls.map((call: unknown[]) => (call[2] as { env?: NodeJS.ProcessEnv }).env?.CODEX_HOME);
  }

  function playLogin(): { env: () => NodeJS.ProcessEnv | undefined } {
    let env: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      env = (args[2] as { env?: NodeJS.ProcessEnv }).env;
      fs.writeFileSync(path.join(env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    return { env: () => env };
  }

  it.each([
    ['device', ['login', '--device-auth']],
    ['browser', ['login']],
  ] as const)(
    'signs in (%s) with the pinned CLI through npx, under an isolated CODEX_HOME',
    async (method, loginArgs) => {
      writeManifest([
        { name: 'agent-browser', version: '0.27.1' },
        { name: '@openai/codex', version: '0.169.0' },
      ]);
      const host = hostWithoutCodex({ status: 0 });
      const login = playLogin();
      // Production passes no root: the manifest is read from the cwd setup.sh set.
      vi.spyOn(process, 'cwd').mockReturnValue(root);
      const stdout = vi.spyOn(process.stdout, 'write');

      const save = vi.fn(async (_provider, credential) => {
        expect(fs.existsSync(credential.file)).toBe(true);
      });
      await runCodexLoginAuth(method, { has: async () => false, save });

      const codexHome = login.env()?.CODEX_HOME;
      expect(codexHome).toBeDefined();
      expect(path.dirname(codexHome!)).toBe(path.join(root, 'data', 'codex-login'));
      expect(save).toHaveBeenCalledWith('codex', { kind: 'oauth', file: path.join(codexHome!, 'auth.json') });
      expect(fs.existsSync(codexHome!)).toBe(false);
      expect(setupLog.step).toHaveBeenCalledWith('auth', 'success', expect.any(Number), {
        PROVIDER: 'codex',
        METHOD: method,
      });

      // npx runs in an empty private project, never the repo, whose
      // node_modules could otherwise supply a different `codex`.
      const npxDir = path.join(codexHome!, 'npx');
      expect(mockSpawnSync).toHaveBeenCalledWith(
        'npx',
        [...NPX_PREFIX, 'exec codex --version'],
        expect.objectContaining({ cwd: npxDir }),
      );
      expect(host.npxProject()).toBe('{ "private": true }\n');
      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        [...NPX_PREFIX, ['exec', 'codex', ...loginArgs].join(' ')],
        expect.objectContaining({ cwd: npxDir, stdio: 'inherit' }),
      );
      // Even `codex --version` creates its CODEX_HOME: both probes use the
      // throwaway one, so ~/.codex is never touched.
      expect(mockSpawnSync.mock.calls.map((call: unknown[]) => call[0])).toEqual(['codex', 'npx']);
      expect(probeHomes()).toEqual([codexHome, codexHome]);

      // The e2e wizard harness proves the fallback ran by this exact line.
      const printed = stdout.mock.calls.map((call: unknown[]) => String(call[0])).join('');
      expect(printed).toContain('Preparing the pinned Codex CLI (0.169.0) for sign-in');
    },
  );

  // The spec goes to `npx --yes`, which runs on the host: anything but an
  // exact pin fails closed before npx is ever spawned.
  it.each([
    ['no manifest', undefined],
    ['no codex entry', [{ name: 'agent-browser', version: '0.27.1' }]],
    ['a range', [{ name: '@openai/codex', version: '^0.169.0' }]],
    ['latest', [{ name: '@openai/codex', version: 'latest' }]],
    // Loose-semver shapes that npm parses as dist-tags.
    ['an empty prerelease part', [{ name: '@openai/codex', version: '0.169.0-..' }]],
    ['a double dot', [{ name: '@openai/codex', version: '0.169.0-a..b' }]],
    ['a number past 2^53', [{ name: '@openai/codex', version: '9007199254740992.0.0' }]],
    ['an oversized prerelease', [{ name: '@openai/codex', version: `0.169.0-${'a'.repeat(300)}` }]],
    ['not a list', { name: '@openai/codex', version: '0.169.0' }],
  ])('refuses to fetch anything with %s', async (_label, tools) => {
    if (tools !== undefined) writeManifest(tools);
    hostWithoutCodex({ status: 0 });

    const result = resolveCodexCli(root, scratch);

    expect(result).toMatchObject({ ok: false, error: 'codex_cli_missing' });
    expect(!result.ok && result.message).toContain('API key');
    // No pin to name, so the install commands take the latest release.
    expect(!result.ok && result.install).toEqual([
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
      'npm install -g @openai/codex',
    ]);
    expect(mockSpawnSync.mock.calls.map((call: unknown[]) => call[0])).toEqual(['codex']);
    expect(probeHomes()).toEqual([scratch]);
  });

  it('names npx and the API key option when npx is not installed', () => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    hostWithoutCodex({ status: null, error: enoent('npx') });

    const result = resolveCodexCli(root, scratch);

    expect(result).toMatchObject({ ok: false, error: 'codex_npx_missing', install: PINNED_INSTALL });
    expect(!result.ok && result.message).toMatch(/npx.*API key/);
  });

  it('names the spawn error when npx exists but cannot start', () => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    const eacces = Object.assign(new Error('spawnSync npx EACCES'), { code: 'EACCES' });
    hostWithoutCodex({ status: null, error: eacces });

    expect(resolveCodexCli(root, scratch)).toMatchObject({
      ok: false,
      error: 'codex_npx_failed',
      detail: ['spawnSync npx EACCES'],
    });
  });

  it("names the API key option and keeps npm's error when the pinned CLI fails to run", async () => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    hostWithoutCodex({ status: 1, stderr: 'npm error code ENOTFOUND\n\nnpm error network request failed\n' });

    const result = resolveCodexCli(root, scratch);

    expect(result).toMatchObject({
      ok: false,
      error: 'codex_npx_failed',
      detail: ['npm error code ENOTFOUND', 'npm error network request failed'],
      install: PINNED_INSTALL,
    });
    expect(!result.ok && result.message).toContain('API key');

    // npm's lines reach the terminal and logs/setup.log; the install
    // commands only the terminal.
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('setup stopped');
    }) as typeof process.exit);
    const log = vi.spyOn(console, 'log');
    await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
      'setup stopped',
    );
    const printed = log.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(printed).toContain('npm error code ENOTFOUND');
    for (const command of PINNED_INSTALL) expect(printed).toContain(command);
    expect(setupLog.step).toHaveBeenCalledWith('auth', 'failed', 0, {
      PROVIDER: 'codex',
      METHOD: 'device',
      ERROR: 'codex_npx_failed',
      MESSAGE: 'npm error code ENOTFOUND | npm error network request failed',
    });
  });

  it('stops setup before any login, and removes its throwaway home, when the pinned CLI fails to run', async () => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    hostWithoutCodex({ status: 1 });
    playLogin();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('setup stopped');
    }) as typeof process.exit);

    await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
      'setup stopped',
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(setupLog.step).toHaveBeenCalledWith('auth', 'failed', 0, {
      PROVIDER: 'codex',
      METHOD: 'device',
      ERROR: 'codex_npx_failed',
    });
    expect(mockSpawn).not.toHaveBeenCalled();
    const [home] = probeHomes();
    expect(home).toBeDefined();
    expect(home).not.toBe(path.join(os.homedir(), '.codex'));
    expect(fs.existsSync(home!)).toBe(false);
  });
});

// A gateway store failure carries the adapter's own message beside the bare
// `gateway_store_failed` code, on both save paths, so the operator and
// logs/setup.log see the cause.
describe('gateway store failures name their cause', () => {
  const failure = new Error('Provider codex does not declare its subscription endpoint');

  function stopOnExit(): { exit: ReturnType<typeof vi.spyOn>; log: ReturnType<typeof vi.spyOn> } {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('setup stopped');
    }) as typeof process.exit);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return { exit, log };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(setupLog.step).mockClear();
  });

  it('after a ChatGPT login, logs the adapter message and prints it under the friendly line', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    const { exit, log } = stopOnExit();

    const save = vi.fn(async () => {
      throw failure;
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-store-root-'));
    try {
      await expect(runCodexLoginAuth('device', { has: async () => false, save }, root)).rejects.toThrow(
        'setup stopped',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(setupLog.step).toHaveBeenCalledWith(
      'auth',
      'failed',
      expect.any(Number),
      expect.objectContaining({
        PROVIDER: 'codex',
        METHOD: 'device',
        ERROR: 'gateway_store_failed',
        MESSAGE: failure.message,
      }),
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes(failure.message))).toBe(true);
  });

  it('after an API key paste, logs the adapter message and prints it under the friendly line', async () => {
    mockPassword.mockResolvedValue('sk-test-not-a-real-key');
    const { exit, log } = stopOnExit();

    const save = vi.fn(async () => {
      throw failure;
    });
    await expect(runCodexApiKeyAuth({ has: async () => false, save })).rejects.toThrow('setup stopped');

    expect(save).toHaveBeenCalledWith('codex', { kind: 'api-key', value: 'sk-test-not-a-real-key' });
    expect(exit).toHaveBeenCalledWith(1);
    expect(setupLog.step).toHaveBeenCalledWith(
      'auth',
      'failed',
      0,
      expect.objectContaining({
        PROVIDER: 'codex',
        METHOD: 'api',
        ERROR: 'gateway_store_failed',
        MESSAGE: failure.message,
      }),
    );
    expect(log.mock.calls.some((call) => String(call[0]).includes(failure.message))).toBe(true);
  });
});

describe('storeFailureMessage', () => {
  it('masks standard base64 tokens containing plus, slash and padding', () => {
    const token = 'Qm9vdHN0cmFwVG9r+ZW5WYWx1ZUhlcmUx/MjM0NTY3ODkw==';
    expect(storeFailureMessage(new Error(`Store rejected ${token}`))).toBe('Store rejected [redacted]');
  });

  it('keeps a plain adapter message intact', () => {
    expect(storeFailureMessage(new Error('Provider codex does not declare its subscription endpoint'))).toBe(
      'Provider codex does not declare its subscription endpoint',
    );
    expect(storeFailureMessage('not an Error')).toBe('not an Error');
  });

  it('withholds the excerpt a real JSON parse error quotes from auth.json', () => {
    let parse: unknown;
    try {
      JSON.parse('{"tokens":{"refresh_token":rt_FAKE_SECRET_VALUE}}');
    } catch (err) {
      parse = err;
    }
    const message = storeFailureMessage(parse);
    expect(message).toContain('SyntaxError');
    expect(message).not.toContain('rt_FAKE');
    expect(message).not.toContain('refresh_token');
    expect(message).not.toContain('sh_token');
  });

  it('masks token-shaped runs in any other message, and keeps one line', () => {
    const token = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0';
    const parse = new Error(`Unexpected token 's', ..."refresh_token":${token}}... is not valid JSON\nstack line`);
    const message = storeFailureMessage(parse);
    expect(message).not.toContain(token);
    expect(message).not.toContain('eyJhbGci');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain('\n');
    expect(message.length).toBeLessThanOrEqual(300);
  });

  it('masks a token that straddles the length cut', () => {
    const key = `sk-proj-${'A'.repeat(64)}`;
    const message = storeFailureMessage(new Error(`${'x '.repeat(146)}${key}`));
    expect(message).not.toContain('sk-proj-AAAA');
    expect(message).not.toContain('AAAAAAAA');
    expect(message.length).toBeLessThanOrEqual(300);
  });
});
