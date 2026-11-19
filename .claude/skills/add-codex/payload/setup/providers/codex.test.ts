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
// The login's process tree is read from the real `ps`; `mockPs.run` (spawn)
// and `mockPs.sync` (spawnSync) stand in for it to play a failing one.
type SpawnPs = (file: string, args: string[], opts: { detached?: boolean }) => unknown;
const mockPs: { run?: SpawnPs; sync?: (...args: unknown[]) => unknown } = {};
// Groups of stand-in listings that leave a process behind.
const strayPs: number[] = [];
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    spawn: (...args: unknown[]) =>
      args[0] === 'ps'
        ? (mockPs.run ?? (real.spawn as unknown as SpawnPs))(...(args as Parameters<SpawnPs>))
        : mockSpawn(...args),
    spawnSync: (...args: unknown[]) =>
      args[0] === 'ps'
        ? (mockPs.sync ?? (real.spawnSync as (...a: unknown[]) => unknown))(...args)
        : mockSpawnSync(...args),
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

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
// ─── real login trees ────────────────────────────────────────────────────

const { spawn: realSpawn, spawnSync: realSpawnSync } =
  await vi.importActual<typeof import('child_process')>('child_process');

/** What went to the screen through these spies. */
const printed = (...spies: Array<ReturnType<typeof vi.spyOn>>): string =>
  spies
    .flatMap((spy) => spy.mock.calls)
    .map((call: unknown[]) => String(call[0]))
    .join('\n');

/** Running, not a zombie waiting to be reaped. */
function isRunning(pid: number): boolean {
  const stat = realSpawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

const treeDirs: string[] = [];
afterEach(() => {
  for (const dir of treeDirs.splice(0)) {
    for (const file of ['wrapper.pid', 'login.pid'].map((name) => path.join(dir, name))) {
      try {
        // Never 0 (an empty file): that would kill the runner's own process group.
        const pid = Number(fs.readFileSync(file, 'utf-8'));
        if (pid > 1) process.kill(pid, 'SIGKILL');
      } catch {
        // Never started, or gone already.
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Plays the login with a real process tree: a wrapper in pnpm's place that
 * exits at once on SIGTERM, and a grandchild in Codex's place that runs
 * `onTerm` on SIGTERM. `ownGroup` starts the grandchild in a group of its own,
 * as pnpm 12 runs Codex. `late` starts it only on SIGTERM, 300 ms before the
 * wrapper exits; `exit` has the wrapper exit by itself, with `auth.json`
 * written into its CODEX_HOME first when `auth` is set. `bareEnv` starts the
 * grandchild with no environment, so no login id; `bareLeader` starts the
 * wrapper without it, as `ps` shows a leader whose environment it can't read.
 * `execOnTerm` plays the grandchild as a shell, with no environment, that
 * execs another program on SIGTERM. `$HELPER` in `onTerm` names a file whose
 * pid counts as the tree's too. All give up after 20 s, so a failing run
 * leaves nothing.
 */
function playTree(
  onTerm: string,
  ownGroup: boolean,
  {
    late = false,
    exit,
    bareEnv = false,
    bareLeader = false,
    execOnTerm = false,
    oddEnv = false,
  }: {
    late?: boolean;
    exit?: { after: number; code: number; auth?: boolean };
    bareEnv?: boolean;
    bareLeader?: boolean;
    execOnTerm?: boolean;
    // The login with a value holding U+2028 and a carriage return.
    oddEnv?: boolean;
  } = {},
): {
  pids: () => number[];
  running: () => boolean;
  home: () => string | undefined;
  id: () => string | undefined;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-tree-'));
  treeDirs.push(dir);
  const [wrapperFile, loginFile, helperFile] = ['wrapper.pid', 'login.pid', 'helper.pid'].map((name) =>
    path.join(dir, name),
  );
  const login =
    `process.on('SIGTERM', () => { ${onTerm.replaceAll('$HELPER', JSON.stringify(helperFile))} });` +
    `require('fs').writeFileSync(${JSON.stringify(loginFile)}, String(process.pid));` +
    `setTimeout(() => {}, 20000);`;
  // A shell that, on SIGTERM, execs into a 300 ms sleep: same pid and group, another command line.
  const shell = `trap 'exec /bin/sleep 0.3' TERM; echo $$ > ${JSON.stringify(loginFile)}; end=$(( $(date +%s) + 20 )); while [ $(date +%s) -lt $end ]; do /bin/sleep 0.05; done`;
  const start = execOnTerm
    ? `require('child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(shell)}], { stdio: 'ignore', detached: ${ownGroup}, env: {} })`
    : `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(login)}], { stdio: 'ignore', detached: ${ownGroup}${bareEnv ? ', env: {}' : ''}${oddEnv ? ", env: { ...process.env, NANOCLAW_ODD: 'a\\u2028b\\rc' }" : ''} })`;
  const wrapper =
    (late ? '' : `${start};`) +
    `require('fs').writeFileSync(${JSON.stringify(wrapperFile)}, String(process.pid));` +
    (late
      ? // The stop may signal it before it can say it runs, so the wrapper does.
        `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(loginFile)}, String(${start}.pid)); setTimeout(() => process.exit(143), 300); });`
      : `process.on('SIGTERM', () => process.exit(143));`) +
    (exit
      ? `setTimeout(() => { ${exit.auth ? "require('fs').writeFileSync(require('path').join(process.env.CODEX_HOME, 'auth.json'), '{}');" : ''} process.exit(${exit.code}); }, ${exit.after});`
      : '') +
    `setTimeout(() => process.exit(1), 20000);`;
  let home: string | undefined;
  let id: string | undefined;
  mockSpawn.mockImplementation((...args: unknown[]) => {
    const opts = args[2] as { env: NodeJS.ProcessEnv };
    home = opts.env.CODEX_HOME;
    id = opts.env.NANOCLAW_CODEX_LOGIN;
    const { NANOCLAW_CODEX_LOGIN: _id, ...rest } = opts.env;
    return realSpawn(process.execPath, ['-e', wrapper], bareLeader ? { ...opts, env: rest } : opts);
  });
  const pids = (): number[] =>
    [wrapperFile, loginFile, helperFile]
      .filter((file) => fs.existsSync(file))
      .map((file) => Number(fs.readFileSync(file, 'utf-8')))
      .filter((pid) => pid > 1);
  return { pids, running: () => pids().some(isRunning), home: () => home, id: () => id };
}

/**
 * Records setup re-raising a signal at itself and removing a login home, with
 * whether the tree still ran at that moment. Other kills (the stop's) are real.
 */
function watchStop(tree: ReturnType<typeof playTree>): {
  reraised: Array<{ signal: unknown; treeRunning: boolean; home: boolean }>;
  removed: Array<{ treeRunning: boolean }>;
  order: string[];
  // Whether the home held auth.json as it went.
  authAtRemoval: boolean[];
} {
  const realKill = process.kill.bind(process);
  const reraised: Array<{ signal: unknown; treeRunning: boolean; home: boolean }> = [];
  // Group signals (not liveness probes) and the home's removal, in order.
  const order: string[] = [];
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid < 0 && signal) order.push(`${String(signal)} ${pid === -tree.pids()[0] ? 'wrapper' : 'other'} group`);
    if (pid !== process.pid) return realKill(pid, signal);
    reraised.push({ signal, treeRunning: tree.running(), home: fs.existsSync(tree.home()!) });
    return true;
  });
  const removed: Array<{ treeRunning: boolean }> = [];
  const authAtRemoval: boolean[] = [];
  const realRm = fs.rmSync.bind(fs);
  vi.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
    if (target === tree.home() && fs.existsSync(target)) {
      removed.push({ treeRunning: tree.running() });
      authAtRemoval.push(fs.existsSync(path.join(target as string, 'auth.json')));
      order.push('home removed');
    }
    realRm(target, opts);
  });
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('setup stopped');
  }) as typeof process.exit);
  return { reraised, removed, order, authAtRemoval };
}

const LOGIN_EVENTS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Delivers `signal` to the sign-in's own handlers, not the test runner's. */
function signalSignIn(runnerOwn: unknown[], signal: (typeof LOGIN_EVENTS)[number]): void {
  process
    .listeners(signal as NodeJS.Signals)
    .filter((listener) => !runnerOwn.includes(listener))
    .forEach((listener) => (listener as (s: NodeJS.Signals) => void)(signal as NodeJS.Signals));
}

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
    mockPs.run = undefined;
    mockPs.sync = undefined;
    vi.restoreAllMocks();
    for (const group of strayPs.splice(0)) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
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
    // Its processes carry an id of the sign-in's own, for stopping them.
    expect(login.env()?.NANOCLAW_CODEX_LOGIN).toMatch(/^[0-9a-f]{16}$/);
    // Its home is named for that id, so a later sign-in can tell whether it's in use.
    expect(path.basename(codexHome!)).toBe(`login-${login.env()?.NANOCLAW_CODEX_LOGIN}`);

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    expect(save).toHaveBeenCalledWith('codex', { kind: 'oauth', file: path.join(codexHome!, 'auth.json') });

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);

    // A host codex that runs is used as is; pnpm never comes into it.
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

  /**
   * On Linux, a home's record of its boot and setup's start (see MADE_FILE):
   * here a start no process on the host follows, so its own processes that
   * Linux won't show (the user's systemd manager) don't keep the home.
   */
  function madeNow(): Record<string, string> {
    if (process.platform !== 'linux') return {};
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim();
    return { '.nanoclaw-made': `${boot} ${Number.MAX_SAFE_INTEGER}\n` };
  }

  /** A home a sign-in left behind, with `files` besides auth.json; `old` puts it two hours back. */
  function leftHome(name: string, old: boolean, files: Record<string, string> = {}): string {
    const dir = path.join(root, 'data', 'codex-login', name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of Object.entries({ 'auth.json': '{}', ...files }))
      fs.writeFileSync(path.join(dir, file), text);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    if (old) fs.utimesSync(dir, twoHoursAgo, twoHoursAgo);
    return dir;
  }

  it('removes a home that a killed sign-in left over an hour ago, and keeps a newer one', async () => {
    const stale = `login-${'a'.repeat(16)}`;
    const recent = `login-${'b'.repeat(16)}`;
    leftHome(stale, true, madeNow());
    leftHome(recent, false, madeNow());
    // Not named for a login id: not setup's to remove.
    leftHome('notes', true);
    playLogin();

    await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);

    expect(fs.readdirSync(path.join(root, 'data', 'codex-login')).sort()).toEqual([recent, 'notes']);
  });

  // An old home may be one whose stop couldn't be confirmed, or whose setup was
  // killed outright while Codex ran on: its age doesn't say the login ended.
  it('keeps an old home while a process carries its login id, and removes it once that ends', async () => {
    const [liveId, otherId] = ['c'.repeat(16), 'd'.repeat(16)];
    const live = leftHome(`login-${liveId}`, true, madeNow());
    const other = leftHome(`login-${otherId}`, true, madeNow());
    const holder = (env: NodeJS.ProcessEnv) =>
      realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
        stdio: 'ignore',
        env: { ...process.env, ...env },
      });
    // The login's Codex, and a look-alike that carries neither id.
    const owner = holder({ NANOCLAW_CODEX_LOGIN: liveId });
    const lookalike = holder({ OLD_NANOCLAW_CODEX_LOGIN: otherId, NANOCLAW_CODEX_LOGIN: `${otherId}0` });
    try {
      await until(() => isRunning(owner.pid!) && isRunning(lookalike.pid!));
      playLogin();
      await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);
      expect(fs.existsSync(path.join(live, 'auth.json'))).toBe(true);
      expect(fs.existsSync(other)).toBe(false);

      owner.kill('SIGKILL');
      await until(() => !isRunning(owner.pid!));
      await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);
      expect(fs.existsSync(live)).toBe(false);
    } finally {
      owner.kill('SIGKILL');
      lookalike.kill('SIGKILL');
    }
  });

  it('keeps an old home when one listing misses the process carrying its id', async () => {
    const id = 'f'.repeat(16);
    const home = leftHome(`login-${id}`, true, madeNow());
    const owner = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], {
      stdio: 'ignore',
      env: { ...process.env, NANOCLAW_CODEX_LOGIN: id },
    });
    try {
      await until(() => isRunning(owner.pid!));
      let listings = 0;
      // The first misses it, as ps may miss a process forked while it reads.
      mockPs.sync = (file, args, opts) => {
        const ps = realSpawnSync(file as string, args as string[], { ...(opts as object), encoding: 'utf-8' });
        if (listings++ === 0) {
          ps.stdout = ps.stdout
            .split('\n')
            .filter((row) => Number(row.trim().split(/\s+/)[0]) !== owner.pid)
            .join('\n');
        }
        return ps;
      };
      playLogin();

      await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);

      expect(listings).toBe(2);
      expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(true);
    } finally {
      owner.kill('SIGKILL');
    }
  });

  it("keeps an old home when ps can't list processes", async () => {
    const old = leftHome(`login-${'e'.repeat(16)}`, true, madeNow());
    mockPs.sync = (_file, args, opts) => realSpawnSync('ps-missing-4455', args as string[], opts as object);
    playLogin();

    await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);

    expect(fs.existsSync(path.join(old, 'auth.json'))).toBe(true);
  });

  /**
   * Plays Linux's /proc for the sweep: `other`'s environment read fails with
   * `code`, and it started at `ticks` (undefined: unknown). Every other
   * environment reads as one without an id. `boot` is this boot's id.
   */
  function fakeProc(other: number, code: string, ticks: number | undefined, boot: string | undefined): () => void {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const read = fs.readFileSync;
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
      if (typeof file !== 'string' || !file.startsWith('/proc/'))
        return (read as (...a: unknown[]) => unknown)(file, ...rest);
      if (file === '/proc/sys/kernel/random/boot_id' && boot) return `${boot}\n`;
      // Setup's own start, for the home it makes.
      if (file === '/proc/self/stat') return '1 (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 9000 0 0';
      if (file === `/proc/${other}/environ`) throw Object.assign(new Error(`${code}: ${file}`), { code });
      // A command name with a space and a ')' in it.
      if (file === `/proc/${other}/stat` && ticks !== undefined) {
        return `${other} (a) b) S 1 1 1 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 ${ticks} 0 0`;
      }
      if (file.endsWith('/environ')) return '';
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    }) as typeof fs.readFileSync);
    return () => Object.defineProperty(process, 'platform', platform);
  }

  // On Linux the sweep reads each listed process's environment from /proc. One
  // it can't read (the user's systemd manager, say) may be a login's, unless it
  // started before the setup that made that login's home; one that has exited
  // isn't, nor is one from an earlier boot. The home records its boot and that
  // setup's start (5000 here) in clock ticks since boot.
  const BOOT = '0b0e0f00-0000-4000-8000-000000000001';
  it.each([
    { code: 'EACCES', ticks: 5001, kept: true },
    { code: 'EPERM', ticks: 5001, kept: true },
    { code: 'EACCES', ticks: 5000, kept: true },
    { code: 'EACCES', ticks: 4999, kept: false },
    { code: 'EACCES', ticks: undefined, kept: true },
    { code: 'EACCES', ticks: 5001, made: 'none', kept: true },
    { code: 'EACCES', ticks: 5001, made: 'earlier boot', kept: false },
    // A record that isn't one: no boot it names can clear the home.
    { code: 'EACCES', ticks: 5001, made: 'malformed', kept: true },
    { code: 'EACCES', ticks: 5001, boot: 'unknown', kept: true },
    // Nor can a boot id that isn't one.
    { code: 'EACCES', ticks: 5001, boot: 'malformed', kept: true },
    // Linux won't show a zombie's environment either, and it uses nothing.
    { code: 'EACCES', ticks: 5001, zombie: true, kept: false },
    { code: 'ENOENT', ticks: 5001, kept: false },
    { code: 'ESRCH', ticks: 5001, kept: false },
  ])(
    'on Linux, a process whose environment read fails with $code, started at $ticks: kept $kept ($made $boot $zombie)',
    async ({ code, ticks, made = 'this boot', boot = 'known', zombie = false, kept }) => {
      const record: Record<string, string> = {
        'this boot': `${BOOT} 5000\n`,
        'earlier boot': '0b0e0f00-0000-4000-8000-000000000002 5000\n',
        malformed: 'unknown 5000\n',
      };
      const boots: Record<string, string | undefined> = { known: BOOT, malformed: 'unknown' };
      const old = leftHome(`login-${'1'.repeat(16)}`, true, made in record ? { '.nanoclaw-made': record[made] } : {});
      const other = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
      let restore = () => {};
      try {
        await until(() => isRunning(other.pid!));
        restore = fakeProc(other.pid!, code, ticks, boots[boot]);
        if (zombie) {
          mockPs.sync = (file, args, opts) => {
            const ps = realSpawnSync(file as string, args as string[], { ...(opts as object), encoding: 'utf-8' });
            ps.stdout = ps.stdout.replace(new RegExp(`^(\\s*${other.pid}\\s+\\d+\\s+\\d+\\s+)\\S+`, 'm'), '$1Z');
            return ps;
          };
        }
        playLogin();

        await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);
      } finally {
        restore();
        other.kill('SIGKILL');
      }
      expect(fs.existsSync(old)).toBe(kept);
    },
  );

  it("on Linux, records in a new home this boot's id and when setup started", async () => {
    let made: string | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const home = (args[2] as { env: NodeJS.ProcessEnv }).env.CODEX_HOME!;
      made = fs.readFileSync(path.join(home, '.nanoclaw-made'), 'utf-8');
      fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    const restore = fakeProc(-1, 'EACCES', undefined, BOOT);
    try {
      await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);
    } finally {
      restore();
    }
    expect(made).toBe(`${BOOT} 9000\n`);
  });

  it("leaves alone an old home another user owns: setup can't list that user's processes", async () => {
    const old = leftHome(`login-${'2'.repeat(16)}`, true, madeNow());
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      const real = (stat as (...a: unknown[]) => fs.Stats)(file, ...rest);
      return file === old ? Object.assign(real, { uid: real.uid + 1 }) : real;
    }) as typeof fs.statSync);
    playLogin();

    await runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);

    expect(fs.existsSync(path.join(old, 'auth.json'))).toBe(true);
  });

  const listeners = () => LOGIN_EVENTS.map((event) => process.listeners(event as NodeJS.Signals));

  /** Starts a sign-in on `tree`; `ready` resolves once both of its processes run. */
  function signInOn(tree: ReturnType<typeof playTree>): { done: Promise<void>; ready: Promise<void> } {
    const done = runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);
    // It settles while a test is still checking the stop; the test awaits it later.
    done.catch(() => {});
    return { done, ready: until(() => tree.pids().length === 2 && tree.running()) };
  }

  // The login has a session of its own, so a signal reaches it only through
  // setup, and setup waits for its whole tree, not just the first process.
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'on %s, stops a login that outlives its wrapper, then removes the home and re-raises',
    async (signal) => {
      const before = listeners();
      const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
      const stop = watchStop(tree);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { done, ready } = signInOn(tree);
      await ready;
      const start = Date.now();
      signalSignIn(before[LOGIN_EVENTS.indexOf(signal)], signal);

      await expect(done).rejects.toThrow('setup stopped');
      expect(mockSpawn.mock.calls[0][2]).toMatchObject({ detached: true, stdio: 'inherit' });
      expect(stop.removed).toEqual([{ treeRunning: false }]);
      expect(stop.reraised).toEqual([{ signal, treeRunning: false, home: false }]);
      // The grandchild in its own group got the SIGTERM; nothing waited for the 3 s kill.
      expect(Date.now() - start).toBeLessThan(2500);
      expect(listeners()).toEqual(before);
    },
  );

  it('still re-raises the signal when removing the home fails', async () => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const rm = fs.rmSync;
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    vi.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      if (target === tree.home()) throw new Error('rm failed');
      rm(target, opts);
    });
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('rm failed');
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: true }]);
    expect(listeners()).toEqual(before);
  });

  it('keeps the home while a login that ignores SIGTERM lives, then kills its group after 3 seconds', async () => {
    const before = listeners();
    const tree = playTree('', false);
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    const [wrapper, login] = tree.pids();
    const start = Date.now();
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');
    await until(() => !isRunning(wrapper));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(isRunning(login)).toBe(true);
    expect(fs.existsSync(tree.home()!)).toBe(true);
    expect(stop.reraised).toEqual([]);

    await expect(done).rejects.toThrow('setup stopped');
    expect(Date.now() - start).toBeGreaterThanOrEqual(2900);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
    expect(listeners()).toEqual(before);
  }, 10_000);

  it('keeps to the 3-second kill when the wall clock jumps ahead during the stop', async () => {
    const before = listeners();
    const tree = playTree('', false);
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    const realNow = Date.now.bind(Date);
    const start = realNow();
    // A minute ahead, from half a second into the stop.
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (realNow() - start > 500 ? 60_000 : 0));
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(realNow() - start).toBeGreaterThanOrEqual(2900);
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGKILL wrapper group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
  });

  it('kills a login that ignores SIGTERM when the stop reaches its deadline before the kill could run', async () => {
    const before = listeners();
    const tree = playTree('', false);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { done, ready } = signInOn(tree);
    await ready;
    const [, login] = tree.pids();
    const realNow = performance.now.bind(performance);
    const start = realNow();
    // Just before the 3 s kill is due, the stop's clock reads past its deadline.
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + (realNow() - start > 2800 ? 5000 : 0));
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(realNow() - start).toBeLessThan(2990);
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGKILL wrapper group']);
    await until(() => !isRunning(login));
    // Not seen to end, so the home stays.
    expect(stop.removed).toEqual([]);
    expect(printed(log, stdout)).toContain("Couldn't confirm that the Codex sign-in stopped");
  });

  it('kills the whole login tree on a second signal, then cleans up', async () => {
    const before = listeners();
    const tree = playTree('', false);
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    const [wrapper, login] = tree.pids();
    const sigterms = before[LOGIN_EVENTS.indexOf('SIGTERM')];
    signalSignIn(sigterms, 'SIGTERM');
    await until(() => !isRunning(wrapper));
    // The first stop leaves the home and the hooks in place.
    expect(isRunning(login)).toBe(true);
    expect(fs.existsSync(tree.home()!)).toBe(true);
    expect(listeners()).not.toEqual(before);
    const start = Date.now();
    signalSignIn(sigterms, 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(Date.now() - start).toBeLessThan(1500);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
    expect(listeners()).toEqual(before);
  });

  // Killing the wrapper first would orphan a member found only through it.
  it('on a second signal before the tree is known, still finds and kills all of it', async () => {
    const before = listeners();
    const tree = playTree('', true, { bareEnv: true });
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    const sigterms = before[LOGIN_EVENTS.indexOf('SIGTERM')];
    signalSignIn(sigterms, 'SIGTERM');
    signalSignIn(sigterms, 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGKILL wrapper group', 'SIGKILL other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
  });

  // Both trees: Codex in pnpm's group (pnpm 10) or in a group of its own (pnpm 12).
  it.each([
    ['in the wrapper group', false, false, ['SIGKILL wrapper group', 'home removed']],
    ['in a group of its own', true, false, ['SIGKILL wrapper group', 'SIGKILL other group', 'home removed']],
    [
      'in a group of its own, with no environment',
      true,
      true,
      ['SIGKILL wrapper group', 'SIGKILL other group', 'home removed'],
    ],
  ])(
    'kills the login tree outright when setup exits mid-sign-in, with the login %s',
    async (_label, ownGroup, bareEnv, order) => {
      const before = listeners();
      const tree = playTree('', ownGroup, { bareEnv });
      const stop = watchStop(tree);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { done, ready } = signInOn(tree);
      await ready;
      signalSignIn(before[0], 'exit');
      // Nothing can wait during 'exit': everything is killed, and seen gone, before the home goes.
      expect(stop.order).toEqual(order);
      expect(stop.removed).toEqual([{ treeRunning: false }]);

      await expect(done).rejects.toThrow('setup stopped');
      expect(listeners()).toEqual(before);
    },
  );

  // A wrapper killed by a signal may leave Codex behind, orphaned. Setup still
  // finds it by the login id it inherited, and stops it before the failure
  // is reported and the home goes.
  // The wrapper's group, held for one more listing, is signalled too.
  it.each([
    ['in the wrapper group', false, ['SIGTERM wrapper group', 'home removed']],
    ['in a group of its own', true, ['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']],
  ])('stops what a wrapper killed by a signal leaves %s, then removes the home', async (_label, ownGroup, order) => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', ownGroup);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { done, ready } = signInOn(tree);
    await ready;
    const [wrapper, login] = tree.pids();
    process.kill(wrapper, 'SIGKILL');

    await expect(done).rejects.toThrow('setup stopped');
    expect(isRunning(login)).toBe(false);
    expect(stop.order).toEqual(order);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([]);
    expect(printed(log, stdout)).toContain("Couldn't complete the Codex sign-in");
    expect(listeners()).toEqual(before);
  });

  it('on a signal while it stops what a killed wrapper left, ends setup after that, with no failure printed', async () => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { done, ready } = signInOn(tree);
    await ready;
    process.kill(tree.pids()[0], 'SIGKILL');
    // The leftovers' stop has begun.
    await until(() => stop.order.length > 0);
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGINT')], 'SIGINT');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.reraised).toEqual([{ signal: 'SIGINT', treeRunning: false, home: false }]);
    expect(printed(log, stdout)).not.toContain("Couldn't");
    expect(listeners()).toEqual(before);
  });

  // pnpm may start Codex while a stop is under way: a later look finds it,
  // and it gets the same signal rather than waiting for the 3 s kill.
  it('stops a login its wrapper starts only after the stop began', async () => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true, { late: true });
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const done = runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);
    done.catch(() => {});
    await until(() => tree.pids().length === 1 && tree.running());
    const start = Date.now();
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(tree.pids()).toHaveLength(2);
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(Date.now() - start).toBeLessThan(2500);
  });

  // A login that signed in took Codex with it; what it leaves running (a
  // browser it opened) isn't setup's.
  it('leaves what a login that signed in left running', async () => {
    const tree = playTree('', true, { exit: { after: 500, code: 0, auth: true } });
    const stop = watchStop(tree);
    const save = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runCodexLoginAuth('device', { has: async () => false, save }, root);
    expect(save).toHaveBeenCalled();
    expect(tree.pids()).toHaveLength(2);
    expect(isRunning(tree.pids()[1])).toBe(true);
    expect(stop.order).toEqual(['home removed']);
  });

  // pnpm 12 exits 0 on a SIGTERM of its own: only a login that signed in is
  // taken to have ended Codex.
  it.each([
    ['fails', 1],
    ['exits 0 without signing in', 0],
  ])('stops what a login that %s by itself leaves, then removes the home', async (_label, code) => {
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true, { exit: { after: 500, code } });
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
      'setup stopped',
    );
    expect(isRunning(tree.pids()[1])).toBe(false);
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(printed(log, stdout)).toMatch(/Couldn't complete the Codex sign-in|ended without signing in/);
  });

  /**
   * Fails listings `from` to `to` (from 1), as if ps were missing or as a ps
   * that errs; the others are real. Returns the count of listings so far.
   */
  function failListing(from: number, to = from, how: 'missing' | 'errs' = 'missing'): () => number {
    let calls = 0;
    mockPs.run = (file, args, opts) => {
      calls += 1;
      if (calls < from || calls > to) return realSpawn(file, args, opts);
      return how === 'missing'
        ? realSpawn(`${file}-missing-4455`, args, opts)
        : realSpawn(process.execPath, ['-e', 'process.exit(3)'], opts);
    };
    return () => calls;
  }

  it('keeps a login that exited 0 without signing in failed, even if what it left writes auth.json while stopped', async () => {
    const tree = playTree(
      "require('fs').writeFileSync(require('path').join(process.env.CODEX_HOME, 'auth.json'), '{}'); process.exit(0);",
      true,
      { exit: { after: 500, code: 0 } },
    );
    const stop = watchStop(tree);
    const save = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runCodexLoginAuth('device', { has: async () => false, save }, root)).rejects.toThrow('setup stopped');
    expect(save).not.toHaveBeenCalled();
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.authAtRemoval).toEqual([true]);
    expect(printed(log, stdout)).toContain('The Codex sign-in ended without signing in');
  });

  // Each listing stands alone: one that fails doesn't stop a later one from
  // finding Codex.
  it('when a listing during the stop fails, a later one still finds the whole tree, and the home goes', async () => {
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = listeners();
    const { done, ready } = signInOn(tree);
    await ready;
    const listings = failListing(2);
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    // After the failed one, two empty listings in a row.
    expect(listings()).toBeGreaterThanOrEqual(4);
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
    expect(printed(log, stdout)).not.toContain("Couldn't confirm");
  });

  it('when every listing after the first signal fails, keeps the home and says why', async () => {
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = listeners();
    const { done, ready } = signInOn(tree);
    await ready;
    failListing(2, Infinity);
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group']);
    expect(tree.running()).toBe(false);
    expect(stop.removed).toEqual([]);
    expect(printed(log, stdout)).toContain(
      "Couldn't confirm that the Codex sign-in stopped: setup couldn't list its processes (ps not found)",
    );
  });

  it('when ps errs twice in a row, a later listing still finds and stops Codex', async () => {
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = listeners();
    const { done, ready } = signInOn(tree);
    await ready;
    failListing(1, 2, 'errs');
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group']);
    expect(tree.running()).toBe(false);
    expect(stop.removed).toEqual([]);
    expect(printed(log, stdout)).toContain(
      "Couldn't confirm that the Codex sign-in stopped: setup couldn't list its processes (ps exited with 3)",
    );
  });

  // ps reads processes one by one, so a listing can miss one forked as its
  // parent went: one empty listing isn't the end.
  it('when one listing during the stop misses the tree, a later one still finds it, and the home waits', async () => {
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = listeners();
    const { done, ready } = signInOn(tree);
    await ready;
    let calls = 0;
    mockPs.run = (file, args, opts) =>
      ++calls === 2
        ? // Only setup's own row, as if the listing had missed the rest.
          realSpawn('/bin/sh', ['-c', `${file} "$@" | grep -E '^ *${process.pid} '`, 'sh', ...args], opts)
        : realSpawn(file, args, opts);
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(calls).toBeGreaterThan(2);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
  });

  // Seeing one group isn't seeing them all: a listing that misses one, while
  // another still shows, doesn't drop it.
  it('holds a group that one listing misses while another group shows, and waits for its helper', async () => {
    const before = listeners();
    const tree = playTree(
      "require('fs').writeFileSync($HELPER, String(require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore', env: {} }).pid)); process.exit(0);",
      true,
    );
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    const [wrapper, login] = tree.pids();
    let calls = 0;
    // Once the login has gone: its group's rows left out, and a row of the
    // login's in the wrapper's group, as if still being read.
    const partial = `while ps -o stat= -p ${login} | grep -qv Z; do sleep 0.01; done; "$0" "$@" | awk '$3 != ${login}'; echo "999999 1 ${wrapper} S node NANOCLAW_CODEX_LOGIN=${tree.id()}"`;
    let partialExit: number | null | undefined;
    mockPs.run = (file, args, opts) => {
      if (++calls !== 2) return realSpawn(file, args, opts);
      const ps = realSpawn('/bin/sh', ['-c', partial, file, ...args], opts);
      ps.on('exit', (code) => (partialExit = code));
      return ps;
    };
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    // A listing, not a failed one.
    expect(partialExit).toBe(0);
    expect(tree.pids()).toHaveLength(3);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
  });

  // ps on Linux cuts an environment off at 128 KiB, and the login id comes after these.
  it('finds a login with a large environment once its wrapper is killed', async () => {
    const big = ['NANOCLAW_BIG1', 'NANOCLAW_BIG2', 'NANOCLAW_BIG3'];
    for (const name of big) process.env[name] = 'x'.repeat(64 * 1024);
    try {
      const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
      const stop = watchStop(tree);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { done, ready } = signInOn(tree);
      await ready;
      process.kill(tree.pids()[0], 'SIGKILL');

      await expect(done).rejects.toThrow('setup stopped');
      expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
      expect(stop.removed).toEqual([{ treeRunning: false }]);
    } finally {
      for (const name of big) delete process.env[name];
    }
  });

  it('finds a login whose environment holds U+2028 or a carriage return', async () => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true, { oddEnv: true });
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
  });

  // A terminal's signals reach every process in its foreground group, so a
  // ps sharing setup's group would die by them, here as soon as it starts.
  const terminalSignals = (opts: { detached?: boolean }) => !opts.detached;

  it('on a second Ctrl-C while ps lists the tree, still lists it, kills all of it and removes the home', async () => {
    const before = listeners();
    const tree = playTree('', true, { bareEnv: true });
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { done, ready } = signInOn(tree);
    await ready;
    mockPs.run = (file, args, opts) => {
      const ps = realSpawn(file, args, opts);
      if (terminalSignals(opts)) ps.kill('SIGINT');
      return ps;
    };
    const sigints = before[LOGIN_EVENTS.indexOf('SIGINT')];
    signalSignIn(sigints, 'SIGINT');
    signalSignIn(sigints, 'SIGINT');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGKILL wrapper group', 'SIGKILL other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(printed(log, stdout)).not.toContain("Couldn't confirm");
  });

  it('on a Ctrl-C while ps lists the tree on the way out, still kills all of it and removes the home', async () => {
    const before = listeners();
    const tree = playTree('', true, { bareEnv: true });
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { done, ready } = signInOn(tree);
    await ready;
    mockPs.sync = (file, args, opts) =>
      terminalSignals(opts as { detached?: boolean })
        ? realSpawnSync('/bin/sh', ['-c', 'kill -INT $$'], opts as object)
        : realSpawnSync(file as string, args as string[], opts as object);
    signalSignIn(before[0], 'exit');

    expect(stop.order).toEqual(['SIGKILL wrapper group', 'SIGKILL other group', 'home removed']);
    expect(tree.running()).toBe(false);
    expect(printed(log, stdout)).not.toContain("Couldn't confirm");
    await expect(done).rejects.toThrow('setup stopped');
    expect(listeners()).toEqual(before);
  });

  // Without a listing before the first signal, a process known only through
  // its parent may go unseen: Codex is still stopped, but the home stays.
  it('when the listing before the first signal fails, stops what it finds later, keeps the home and says so', async () => {
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = listeners();
    const { done, ready } = signInOn(tree);
    await ready;
    failListing(1);
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group']);
    expect(tree.running()).toBe(false);
    expect(stop.removed).toEqual([]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: true }]);
    expect(printed(log, stdout)).toContain(
      "Couldn't confirm that the Codex sign-in stopped: setup couldn't list its processes (ps not found)",
    );
  });

  it.each([
    ['whose login id only starts the same', (id: string) => ({ env: { NANOCLAW_CODEX_LOGIN: `${id}0` } })],
    ['with the id in OLD_NANOCLAW_CODEX_LOGIN', (id: string) => ({ env: { OLD_NANOCLAW_CODEX_LOGIN: id } })],
    ['naming it inside an argument', (id: string) => ({ arg: `--note=NANOCLAW_CODEX_LOGIN=${id}` })],
  ])("stops only the sign-in's own processes, not one %s", async (_label, decoyOf) => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    const { env, arg } = decoyOf(tree.id()!) as { env?: Record<string, string>; arg?: string };
    const decoy = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', ...(arg ? ['--', arg] : [])], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, ...env },
    });
    try {
      await until(() => isRunning(decoy.pid!));
      signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

      await expect(done).rejects.toThrow('setup stopped');
      expect(isRunning(decoy.pid!)).toBe(true);
      expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    } finally {
      decoy.kill('SIGKILL');
    }
  });

  // macOS hides a system binary's environment: such a member is found through
  // its parent, and still waited for once that has gone.
  it('stops a member with no environment, and waits for it after its parent has gone', async () => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true, { bareEnv: true });
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
  });

  // The login has a session of its own, so its leader's group holds only its processes.
  it('stops what a login that fails leaves in its group, even what shows no environment', async () => {
    const tree = playTree('setTimeout(() => process.exit(0), 300)', false, {
      bareEnv: true,
      exit: { after: 500, code: 1 },
    });
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
      'setup stopped',
    );
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
  });

  it('waits for a member that runs another program after its parent has gone', async () => {
    const before = listeners();
    const tree = playTree('', true, { execOnTerm: true });
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
  });

  it('waits for a helper that a member starts in its own group on SIGTERM, with no environment, before exiting', async () => {
    const before = listeners();
    const tree = playTree(
      "require('fs').writeFileSync($HELPER, String(require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'], { stdio: 'ignore', env: {} }).pid)); process.exit(0);",
      true,
    );
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(tree.pids()).toHaveLength(3);
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'SIGTERM other group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
  });

  it("stops a login whose own environment ps can't show", async () => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', false, { bareLeader: true });
    const stop = watchStop(tree);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { done, ready } = signInOn(tree);
    await ready;
    signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

    await expect(done).rejects.toThrow('setup stopped');
    expect(stop.order).toEqual(['SIGTERM wrapper group', 'home removed']);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: false, home: false }]);
  });

  it('when ps is missing on the way out, kills what it knows, keeps the home and says so', async () => {
    const before = listeners();
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { done, ready } = signInOn(tree);
    await ready;
    mockPs.sync = (_file, args, opts) => realSpawnSync('ps-missing-4455', args as string[], opts as object);
    signalSignIn(before[0], 'exit');

    // Only the group it knew got the kill, and the home stays.
    expect(stop.order).toEqual(['SIGKILL wrapper group']);
    expect(stop.removed).toEqual([]);
    expect(fs.existsSync(tree.home()!)).toBe(true);
    expect(printed(log, stdout)).toContain(
      "Couldn't confirm that the Codex sign-in stopped: setup couldn't list its processes (ps not found)",
    );
    await expect(done).rejects.toThrow('setup stopped');
    expect(listeners()).toEqual(before);
  });

  // A slow first listing leaves time for another, within the 1.5 s.
  it.each([
    ['fails', ['ps-missing-4455'], 'ps not found'],
    // One that ignores SIGTERM.
    [
      'times out',
      [process.execPath, '-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)"],
      'ps timed out',
    ],
  ])(
    'when the first listing on the way out %s, kills what later ones find, keeps the home and says so',
    async (_label, first, why) => {
      const before = listeners();
      const tree = playTree('', true);
      const stop = watchStop(tree);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { done, ready } = signInOn(tree);
      await ready;
      let calls = 0;
      mockPs.sync = (file, args, opts) =>
        ++calls === 1
          ? realSpawnSync(first[0], first.slice(1), opts as object)
          : realSpawnSync(file as string, args as string[], opts as object);
      const start = Date.now();
      signalSignIn(before[0], 'exit');

      expect(Date.now() - start).toBeLessThan(2500);
      expect(stop.order).toEqual(['SIGKILL wrapper group', 'SIGKILL other group']);
      expect(tree.running()).toBe(false);
      expect(stop.removed).toEqual([]);
      expect(printed(log, stdout)).toContain(
        `Couldn't confirm that the Codex sign-in stopped: setup couldn't list its processes (${why})`,
      );
      await expect(done).rejects.toThrow('setup stopped');
      expect(listeners()).toEqual(before);
    },
  );

  // Without a listing, setup can't see a group Codex moved to: it stops what
  // it knows, then says so and keeps the home rather than claim the tree is gone.
  it.each([
    [
      'is missing',
      ((file, args, opts) => realSpawn(`${file}-missing-4455`, args, opts)) satisfies SpawnPs,
      'ps not found',
      ['SIGTERM wrapper group'],
    ],
    [
      "can't start",
      (() => {
        throw Object.assign(new Error('spawn ps ENOMEM'), { code: 'ENOMEM' });
      }) satisfies SpawnPs,
      'ps: spawn ps ENOMEM',
      // Another start may work, so the stop keeps trying, to the 3 s kill.
      ['SIGTERM wrapper group', 'SIGKILL wrapper group'],
    ],
    [
      'times out',
      // One that leaves a child holding its output open.
      ((_file, _args, opts) => {
        const ps = realSpawn('/bin/sh', ['-c', '/bin/sleep 10 & /bin/sleep 10'], opts);
        if (ps.pid) strayPs.push(ps.pid);
        return ps;
      }) satisfies SpawnPs,
      'ps timed out',
      // A timeout may pass, so the stop keeps trying, to the 3 s kill.
      ['SIGTERM wrapper group', 'SIGKILL wrapper group'],
    ],
  ])(
    'when ps %s, stops the groups it knows, keeps the home and says so',
    async (_label, run, why, order) => {
      const before = listeners();
      const tree = playTree('', true);
      const stop = watchStop(tree);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockPs.run = run;
      const { done, ready } = signInOn(tree);
      await ready;
      const [, login] = tree.pids();
      const start = Date.now();
      signalSignIn(before[LOGIN_EVENTS.indexOf('SIGTERM')], 'SIGTERM');

      await expect(done).rejects.toThrow('setup stopped');
      expect(Date.now() - start).toBeLessThan(8000);
      // Codex, in the group setup never saw, still runs, and its home stays.
      expect(stop.order).toEqual(order);
      expect(isRunning(login)).toBe(true);
      expect(stop.removed).toEqual([]);
      expect(stop.reraised).toEqual([{ signal: 'SIGTERM', treeRunning: true, home: true }]);
      const out = printed(log, stdout);
      expect(out).toContain(
        `Couldn't confirm that the Codex sign-in stopped: setup couldn't list its processes (${why})`,
      );
      expect(out).toContain(path.relative(root, tree.home()!));
      expect(listeners()).toEqual(before);
    },
    10_000,
  );
});

// #3791: a host without `codex` runs the image's pinned CLI through pnpm dlx
// instead of asking for a global install, which fails for users without
// write access to the npm prefix.
describe('runCodexLoginAuth without a host Codex CLI', () => {
  const DLX = ['--config.ignore-scripts=true', '--package=@openai/codex@0.169.0', 'dlx', 'codex'];
  const PINNED_INSTALL = [
    'curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release 0.169.0',
    'npm install -g @openai/codex@0.169.0',
  ];
  const enoent = (cmd: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: 'ENOENT' });

  let root: string;
  let scratch: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pnpm-root-'));
    fs.mkdirSync(path.join(root, 'container'));
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-pnpm-scratch-'));
    // `codex` is not on PATH.
    mockSpawnSync.mockReturnValue({ status: null, signal: null, stdout: '', stderr: '', error: enoent('codex') });
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

  /** The CODEX_HOME every probe ran under. */
  function probeHomes(): Array<string | undefined> {
    return mockSpawnSync.mock.calls.map((call: unknown[]) => (call[2] as { env?: NodeJS.ProcessEnv }).env?.CODEX_HOME);
  }

  /** Plays the login: writes auth.json into its CODEX_HOME when `code` is 0, then closes with `code`. */
  function playLogin(code = 0): { env: () => NodeJS.ProcessEnv | undefined } {
    let env: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      env = (args[2] as { env?: NodeJS.ProcessEnv }).env;
      if (code === 0) fs.writeFileSync(path.join(env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', code));
      return child;
    });
    return { env: () => env };
  }

  function stopOnExit(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('setup stopped');
    }) as typeof process.exit);
  }

  const printedBy = (...spies: Array<ReturnType<typeof vi.spyOn>>): string =>
    spies
      .flatMap((spy) => spy.mock.calls)
      .map((call: unknown[]) => String(call[0]))
      .join('\n');

  it.each([
    ['device', ['login', '--device-auth']],
    ['browser', ['login']],
  ] as const)(
    'signs in (%s) with the pinned CLI through pnpm dlx, under an isolated CODEX_HOME',
    async (method, loginArgs) => {
      writeManifest([
        { name: 'agent-browser', version: '0.27.1' },
        { name: '@openai/codex', version: '0.169.0' },
      ]);
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

      // pnpm fetches the exact pin and runs its `codex` as the login itself.
      expect(mockSpawn.mock.calls).toEqual([
        ['pnpm', [...DLX, ...loginArgs], expect.objectContaining({ stdio: 'inherit', detached: true })],
      ]);
      // Even `codex --version` creates its CODEX_HOME: the probe uses the
      // throwaway one, so ~/.codex is never touched.
      expect(mockSpawnSync.mock.calls.map((call: unknown[]) => call[0])).toEqual(['codex']);
      expect(probeHomes()).toEqual([codexHome]);

      // The e2e wizard harness proves the fallback ran by this exact line.
      expect(printedBy(stdout)).toContain('Preparing the pinned Codex CLI (0.169.0) for sign-in');
    },
  );

  // The spec goes to pnpm, which runs it on the host: anything but an exact
  // pin fails closed before pnpm is ever spawned.
  it.each([
    ['no manifest', undefined],
    ['no codex entry', [{ name: 'agent-browser', version: '0.27.1' }]],
    ['a range', [{ name: '@openai/codex', version: '^0.169.0' }]],
    ['latest', [{ name: '@openai/codex', version: 'latest' }]],
    // Loose-semver shapes that npm and pnpm parse as dist-tags.
    ['an empty prerelease part', [{ name: '@openai/codex', version: '0.169.0-..' }]],
    ['a double dot', [{ name: '@openai/codex', version: '0.169.0-a..b' }]],
    ['a number past 2^53', [{ name: '@openai/codex', version: '9007199254740992.0.0' }]],
    ['an oversized prerelease', [{ name: '@openai/codex', version: `0.169.0-${'a'.repeat(300)}` }]],
    ['not a list', { name: '@openai/codex', version: '0.169.0' }],
  ])('refuses to fetch anything with %s', async (_label, tools) => {
    if (tools !== undefined) writeManifest(tools);

    const result = resolveCodexCli(root, scratch);

    expect(result).toMatchObject({
      ok: false,
      error: 'codex_cli_missing',
      // OpenAI's installer puts ~/.local/bin on PATH through the shell
      // profile, which the shell setup runs in hasn't read.
      message: expect.stringMatching(/re-run setup in a new terminal.*API key/),
      // No pin to name, so the install commands take the latest release.
      install: ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'npm install -g @openai/codex'],
    });
    expect(mockSpawnSync.mock.calls.map((call: unknown[]) => call[0])).toEqual(['codex']);
    expect(probeHomes()).toEqual([scratch]);
  });

  it('with no pin, prints both install commands and stops before any login', async () => {
    const exit = stopOnExit();
    const log = vi.spyOn(console, 'log');

    await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
      'setup stopped',
    );

    expect(exit).toHaveBeenCalledWith(1);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(printedBy(log)).toContain('curl -fsSL https://chatgpt.com/codex/install.sh | sh');
    expect(setupLog.step).toHaveBeenCalledWith('auth', 'failed', 0, {
      PROVIDER: 'codex',
      METHOD: 'device',
      ERROR: 'codex_cli_missing',
    });
    const [home] = probeHomes();
    expect(home).not.toBe(path.join(os.homedir(), '.codex'));
    expect(fs.existsSync(home!)).toBe(false);
  });

  // pnpm prints its own fetch error to the terminal, above this message.
  it.each([
    ['pnpm exits non-zero', () => playLogin(1), { EXIT_CODE: '1' }],
    [
      'pnpm cannot start',
      () =>
        mockSpawn.mockImplementation(() => {
          const child = new EventEmitter();
          setImmediate(() => child.emit('error', Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' })));
          return child;
        }),
      // It never ran, so it has no exit code; its error is printed instead.
      { ERROR: 'codex_spawn_failed', MESSAGE: 'spawn pnpm ENOENT' },
    ],
  ])('when %s, names the installer, a new terminal and the API key option', async (_label, play, logged) => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    play();
    const exit = stopOnExit();
    const log = vi.spyOn(console, 'log');
    const stdout = vi.spyOn(process.stdout, 'write');
    const save = vi.fn();

    await expect(runCodexLoginAuth('device', { has: async () => false, save }, root)).rejects.toThrow('setup stopped');

    expect(exit).toHaveBeenCalledWith(1);
    expect(save).not.toHaveBeenCalled();
    const printed = printedBy(log, stdout);
    expect(printed).toMatch(/pinned Codex CLI 0\.169\.0.*re-run setup in a new terminal.*API key/s);
    for (const command of PINNED_INSTALL) expect(printed).toContain(command);
    if ('MESSAGE' in logged) expect(printed).toContain(logged.MESSAGE);
    expect(setupLog.step).toHaveBeenCalledWith('auth', 'failed', expect.any(Number), {
      PROVIDER: 'codex',
      METHOD: 'device',
      ...logged,
      CLI: 'pnpm dlx @openai/codex@0.169.0',
    });
    expect(fs.readdirSync(path.join(root, 'data', 'codex-login'))).toEqual([]);
  });

  it('when a host Codex login fails, says to retry, with no install commands', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, signal: null, stdout: 'codex-cli 0.169.0', stderr: '' });
    playLogin(1);
    stopOnExit();
    const log = vi.spyOn(console, 'log');
    const stdout = vi.spyOn(process.stdout, 'write');

    await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
      'setup stopped',
    );

    const printed = printedBy(log, stdout);
    expect(printed).toContain('Re-run setup and try again');
    expect(printed).not.toContain('install.sh');
    expect(setupLog.step).toHaveBeenCalledWith('auth', 'failed', expect.any(Number), {
      PROVIDER: 'codex',
      METHOD: 'device',
      EXIT_CODE: '1',
    });
  });

  // Ctrl-C reaches the probe too, and setup's own handler runs only once the
  // probe returns: a probe a stop signal ended means setup is stopping.
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'reports a stop, not a failure, when the probe ends on %s',
    (signal) => {
      writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
      mockSpawnSync.mockReturnValue({ status: null, signal, stdout: '', stderr: '' });

      expect(resolveCodexCli(root, scratch)).toEqual({ ok: false, stoppedBy: signal });
    },
  );

  it.each([
    ['dies of any other signal', { status: null, signal: 'SIGKILL' }],
    // spawnSync kills a child that overflows its buffer, and says so.
    [
      'is killed by Node for overflowing',
      {
        status: null,
        signal: 'SIGTERM',
        error: Object.assign(new Error('spawnSync codex ENOBUFS'), { code: 'ENOBUFS' }),
      },
    ],
    ['fails', { status: 2, signal: null }],
  ])('runs the pin through pnpm when the probe %s', (_label, probed) => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    mockSpawnSync.mockReturnValue({ stdout: '', stderr: '', ...probed });

    expect(resolveCodexCli(root, scratch)).toEqual({ ok: true, command: 'pnpm', prefix: DLX, pinned: '0.169.0' });
  });

  it('on Ctrl-C during the probe, removes the home and re-raises the signal, with no error', async () => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    mockSpawnSync.mockReturnValue({ status: null, signal: 'SIGINT', stdout: '', stderr: '' });
    const listeners = () => ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'].map((event) => process.listenerCount(event));
    const before = listeners();
    let homeAtKill: boolean | undefined;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      homeAtKill = fs.existsSync(probeHomes()[0]!);
      return true;
    });
    const exit = stopOnExit();
    const stdout = vi.spyOn(process.stdout, 'write');
    const log = vi.spyOn(console, 'log');

    await expect(runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root)).rejects.toThrow(
      'setup stopped',
    );

    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT');
    expect(homeAtKill).toBe(false);
    // The exit only backs up the re-raised signal.
    expect(kill.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(setupLog.step).not.toHaveBeenCalled();
    const printed = printedBy(stdout, log);
    expect(printed).not.toContain("Couldn't");
    expect(printed).not.toContain(PINNED_INSTALL[0]);
    expect(listeners()).toEqual(before);
  });

  // The fetch runs inside the login spawn, so setup's own handler is live:
  // Ctrl-C mid-fetch stops pnpm's whole tree like any login, with no error.
  it('on Ctrl-C while pnpm fetches, stops its tree, then removes the home and re-raises the signal', async () => {
    writeManifest([{ name: '@openai/codex', version: '0.169.0' }]);
    const runnerOwn = process.listeners('SIGINT');
    const tree = playTree('setTimeout(() => process.exit(0), 300)', true);
    const stop = watchStop(tree);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, 'write');
    const done = runCodexLoginAuth('device', { has: async () => false, save: vi.fn() }, root);
    done.catch(() => {});
    await until(() => tree.pids().length === 2 && tree.running());
    signalSignIn(runnerOwn, 'SIGINT');

    await expect(done).rejects.toThrow('setup stopped');
    expect(mockSpawn.mock.calls[0].slice(0, 2)).toEqual(['pnpm', [...DLX, 'login', '--device-auth']]);
    expect(stop.removed).toEqual([{ treeRunning: false }]);
    expect(stop.reraised).toEqual([{ signal: 'SIGINT', treeRunning: false, home: false }]);
    const printed = printedBy(log, stdout);
    expect(printed).toContain('pnpm fetches it once');
    expect(printed).not.toContain("Couldn't");
    expect(printed).not.toContain(PINNED_INSTALL[0]);
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
