/**
 * Codex owns its login prompts and dedicated OAuth session. The selected
 * gateway owns credential storage, injection, and refresh. No personal
 * ~/.codex/auth.json is copied: rotating one session from two consumers
 * would invalidate it. Both setup entry points use this provider hook.
 */
import { type ChildProcess, execFile, spawn, spawnSync } from 'child_process';
import { getCredentialStore, type ProviderCredentialStore } from '../gateways/credential-store.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { brightSelect } from '../lib/bright-select.js';
import { type AssistContext, BIG_PICTURE_FILES, STEP_FILES } from '../lib/claude-assist.js';
import { brandBody, note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { type FailureAssistResult, registerSetupProvider } from './registry.js';

// ─── auth step ───────────────────────────────────────────────────────────

/**
 * The gateway adapter's own message, kept beside the friendly line so a store
 * failure names its cause in logs/setup.log and on screen. Adapters throw
 * plain messages, but a parse error quotes
 * its input (a malformed auth.json would put token text in the message), so
 * token-shaped runs are masked and the message is kept to its first line.
 */
export function storeFailureMessage(err: unknown): string {
  // A JSON parse error quotes a short excerpt of its input (shorter than the
  // token mask below); the store may be parsing a credential file, so keep the
  // error class and drop the excerpt without naming the input.
  if (err instanceof SyntaxError) return `${err.name}: a JSON input could not be parsed (excerpt withheld)`;
  const raw = err instanceof Error ? err.message : String(err);
  // Mask before cutting: a cut could shorten a token below the mask threshold.
  return raw
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, '[redacted]')
    .split('\n')[0]
    .slice(0, 300);
}

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

export async function runCodexAuthStep(): Promise<void> {
  const store = await getCredentialStore();
  if (await store.has('codex')) {
    p.log.success(brandBody('Your OpenAI account is already connected.'));
    setupLog.step('auth', 'skipped', 0, { REASON: 'openai-secret-already-present', PROVIDER: 'codex' });
    return;
  }

  const method = ensureAnswer(
    await brightSelect<'browser' | 'device' | 'api' | 'skip'>({
      message: 'How would you like to connect Codex?',
      options: [
        {
          value: 'browser',
          label: 'Sign in with my ChatGPT subscription',
          hint: 'recommended if you have Plus or Pro — opens a browser',
        },
        {
          value: 'device',
          label: 'ChatGPT device pairing',
          hint: 'no browser handoff — shows a URL and a code',
        },
        {
          value: 'api',
          label: 'Paste an OpenAI API key',
          hint: 'pay-per-use; stored in your gateway, never copied into the container',
        },
        {
          value: 'skip',
          label: "Skip — I'll connect later",
          hint: 'Codex groups will start, but model calls will fail auth',
        },
      ],
    }),
  );
  setupLog.userInput('codex_auth_method', method);

  if (method === 'skip') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: "Skip Codex sign-in? Codex won't be able to answer until you connect an OpenAI account.",
        initialValue: false,
      }),
    );
    if (!confirmed) return runCodexAuthStep();
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped', PROVIDER: 'codex' });
    p.log.warn(brandBody('Codex sign-in skipped. Add an OpenAI account to your gateway before using Codex groups.'));
    return;
  }

  if (method === 'api') {
    await runCodexApiKeyAuth(store);
    return;
  }

  await runCodexLoginAuth(method, store);
}

export async function runCodexApiKeyAuth(store: ProviderCredentialStore): Promise<void> {
  const key = ensureAnswer(
    await p.password({
      message: 'Paste your OpenAI API key (sk-…)',
      validate: (v) => (v && v.trim().startsWith('sk-') ? undefined : 'That does not look like an OpenAI API key.'),
    }),
  ) as string;

  try {
    await store.save('codex', { kind: 'api-key', value: key.trim() });
  } catch (err) {
    const message = storeFailureMessage(err);
    setupLog.step('auth', 'failed', 0, {
      PROVIDER: 'codex',
      METHOD: 'api',
      ERROR: 'gateway_store_failed',
      MESSAGE: message,
    });
    p.log.error(brandBody("Couldn't save your OpenAI key to the vault. Check the selected gateway, then retry."));
    console.log(k.dim(`   ${message}`));
    process.exit(1);
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'codex', METHOD: 'api' });
  p.log.success(brandBody('OpenAI account connected.'));
}

// semver.org's strict grammar, with bounded numbers and no build metadata.
// npm and pnpm read anything they can't parse as a version (`0.169.0-..`,
// numbers past 2^53, specs over 256 chars) as a dist-tag, which can point anywhere.
const EXACT_VERSION =
  /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;

/** The exact `@openai/codex` version in the CLI manifest, or undefined when absent or not an exact pin. */
export function readPinnedCodexVersion(root: string): string | undefined {
  try {
    const tools = JSON.parse(fs.readFileSync(path.join(root, 'container', 'cli-tools.json'), 'utf-8')) as unknown;
    if (!Array.isArray(tools)) return undefined;
    const version = (tools as Array<{ name?: unknown; version?: unknown } | null>).find(
      (t) => t?.name === '@openai/codex',
    )?.version;
    return typeof version === 'string' && version.length <= 64 && EXACT_VERSION.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** OpenAI's installer (no sudo, into ~/.local/bin), then npm for a prefix it can write. */
export function codexInstallCommands(version?: string): string[] {
  return version
    ? [
        `curl -fsSL https://chatgpt.com/codex/install.sh | sh -s -- --release ${version}`,
        `npm install -g @openai/codex@${version}`,
      ]
    : ['curl -fsSL https://chatgpt.com/codex/install.sh | sh', 'npm install -g @openai/codex'];
}

type CodexCli =
  | { ok: true; command: string; prefix: string[]; pinned?: string }
  | { ok: false; stoppedBy: NodeJS.Signals }
  | { ok: false; error: string; message: string; install: string[] };

/**
 * The host's `codex` when it runs; otherwise the version pinned for the image,
 * run by pnpm dlx from pnpm's cache (no global install, no sudo), the way setup
 * runs the pinned Bun. The spec runs on the host, so only an exact pin is used.
 * `home` is the probe's CODEX_HOME.
 */
export function resolveCodexCli(root: string, home: string): CodexCli {
  // Any codex run, even `--version`, creates its CODEX_HOME (default ~/.codex).
  const host = spawnSync('codex', ['--version'], {
    env: { ...process.env, CODEX_HOME: home },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (host.status === 0) return { ok: true, command: 'codex', prefix: [] };
  // Ctrl-C reaches this probe too, before setup's own handler can run: setup
  // is stopping, nothing failed. Node's own kill on a buffer overflow comes
  // with an error and isn't a stop.
  const stoppedBy = host.error ? undefined : LOGIN_SIGNALS.find((signal) => signal === host.signal);
  if (stoppedBy) return { ok: false, stoppedBy };

  const version = readPinnedCodexVersion(root);
  if (!version) {
    return {
      ok: false,
      error: 'codex_cli_missing',
      message:
        "The Codex CLI isn't installed on this machine, and container/cli-tools.json has no exact @openai/codex version to run instead. Install the Codex CLI (below) or run the /add-codex skill again, then re-run setup in a new terminal — or choose the API key option instead.",
      install: codexInstallCommands(),
    };
  }
  // pnpm runs the named package's own install scripts; the image install runs
  // none of Codex's, so neither does this.
  return {
    ok: true,
    command: 'pnpm',
    prefix: ['--config.ignore-scripts=true', `--package=@openai/codex@${version}`, 'dlx', 'codex'],
    pinned: version,
  };
}

export async function runCodexLoginAuth(
  method: 'browser' | 'device',
  store?: ProviderCredentialStore,
  // setup.sh runs from the repo root, where the CLI manifest lives.
  root = process.cwd(),
): Promise<void> {
  store ??= await getCredentialStore();

  // Session-isolation invariant: the login runs under a
  // throwaway CODEX_HOME so the vaulted session is dedicated to the gateway
  // and never shared with the user's personal ~/.codex.
  const loginHome = makeLoginHome(root);
  // Holds a live credential after login, so it goes on every exit path:
  // `finally` for returns and throws, the exit hook for process.exit (which
  // skips finally), and the signal hook for Ctrl-C, SIGTERM and a hangup.
  const removeLoginHome = (): void => fs.rmSync(loginHome, { recursive: true, force: true });
  // The login runs in a session of its own (see runInherit).
  let tree: LoginTree | undefined;
  // Not once the login has signed in: what it leaves (a browser it opened)
  // isn't setup's.
  let owned = true;
  let stopping: Promise<void> | undefined;
  let raise: NodeJS.Signals | undefined;
  let level: NodeJS.Signals = 'SIGTERM';
  // Whether the whole tree was seen to end; the home goes only then.
  let ended: boolean | undefined;
  // Once the stop has listed the tree: a kill before that could orphan a
  // member it finds only through its parent.
  let listed = false;
  let cleaned = false;
  const cleanUp = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (!tree || !owned || ended) return removeLoginHome();
    // Part of the login may still run and write to the home: it stays, and
    // the next sign-in removes it once it's an hour old.
    const failure = tree.failure ?? tree.blind;
    const why = failure
      ? `setup couldn't list its processes (${failure})`
      : 'part of it was still running after it was killed';
    p.log.warn(
      brandBody(
        `Couldn't confirm that the Codex sign-in stopped: ${why}. Close any Codex sign-in still running. Its sign-in folder stays at ${path.relative(root, loginHome)}; the next Codex sign-in removes it once it's an hour old.`,
      ),
    );
  };
  // On the way out (process.exit skips finally) nothing can wait: what is left
  // of the login is killed outright, then looked for once more.
  const release = (): void => {
    if (tree && owned && ended === undefined) ended = tree.killAll();
    cleanUp();
  };
  const detach = (): void => {
    process.off('exit', release);
    for (const signal of LOGIN_SIGNALS) process.off(signal, onSignal);
  };
  const finish = (signal: NodeJS.Signals): void => {
    detach();
    cleanUp();
    process.kill(process.pid, signal);
  };
  // No signal reaches the login but this stop. Every group of its tree gets
  // SIGTERM, then SIGKILL after 3s or on a second signal; it has ended once a
  // listing shows none of it. The hooks stay attached until then.
  async function stopTree(login: LoginTree): Promise<void> {
    // Before any signal, while a member without CODEX_HOME is still linked to its parent.
    await login.look();
    listed = true;
    login.signal(level);
    const timer = setTimeout(() => {
      level = 'SIGKILL';
      login.signal(level);
    }, STOP_GRACE_MS);
    // Bounded, in case a member never goes.
    const end = Date.now() + STOP_GRACE_MS + 1000;
    let live = await login.look(() => level);
    // Without a listing nothing can be confirmed; once no group answers, waiting can't help.
    while (live !== false && Date.now() < end && (live || login.signal(0))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      live = await login.look(() => level);
    }
    clearTimeout(timer);
    ended = live === false && !login.blind;
  }
  function onSignal(signal: NodeJS.Signals): void {
    if (stopping) {
      // A signal while a failed login's leftovers stop ends setup after them.
      if (!raise) {
        raise = signal;
        return;
      }
      // A second signal kills at once, or as soon as the tree is listed.
      level = 'SIGKILL';
      if (listed) tree?.signal('SIGKILL');
      return;
    }
    raise = signal;
    if (!tree || !owned) return finish(signal);
    stopping = stopTree(tree).then(() => finish(signal));
  }
  const onSpawn = (child: ChildProcess): void => {
    if (!child.pid) return;
    const login = (tree = new LoginTree(child.pid, loginHome));
    child.once('close', (code) => {
      if (stopping) return;
      // Signed in, the login took Codex with it.
      if (code === 0 && fs.existsSync(path.join(loginHome, 'auth.json'))) {
        owned = false;
        return;
      }
      // Killed, or ended without signing in: Codex may be left, so it stops
      // before the failure is reported, or before a signal meanwhile ends setup.
      stopping = stopTree(login).then(() => {
        if (raise) finish(raise);
      });
    });
  };
  process.on('exit', release);
  for (const signal of LOGIN_SIGNALS) process.on(signal, onSignal);
  try {
    await signIn(method, store, root, loginHome, {
      onSpawn,
      stop: onSignal,
      settled: async () => {
        if (!stopping) return;
        await stopping;
        // A stop for a signal ends setup with nothing printed; the exit backs
        // up the re-raised signal.
        if (raise) process.exit(1);
      },
    });
  } finally {
    detach();
    release();
  }
}

type Proc = { pid: number; ppid: number; pgid: number; zombie: boolean; text: string };

/**
 * The login's process tree. A listing finds its processes by the CODEX_HOME
 * each inherits, whatever became of its parent; one without it (macOS hides a
 * system binary's environment, such as pnpm 12's `sh`) by descent, and after
 * that as the same pid in the same group. Every process in the leader's group
 * is one: the login runs in a session of its own (see runInherit). Their
 * groups are the ones signalled: pnpm 12 runs Codex in a group of its own.
 * Zombies don't count.
 */
class LoginTree {
  // As of the last listing; the login's own until there is one.
  private groups: number[];
  // Each member's group as last listed.
  private known = new Map<number, number>();
  private readonly marker: string;
  private signalled = false;
  failure: string | undefined;
  // Why no listing came before the first signal: a member linked only
  // through its parent may then have gone unseen, so the end can't be confirmed.
  blind: string | undefined;

  constructor(
    private readonly leader: number,
    home: string,
  ) {
    this.groups = [leader];
    this.marker = `CODEX_HOME=${home}`;
  }

  /** Lists the tree; whether any of it runs (undefined without a listing). New groups get `signal()`. */
  async look(signal?: () => NodeJS.Signals): Promise<boolean | undefined> {
    return this.take(await listProcs(), signal);
  }

  /** Signals the groups; whether any still holds a member. */
  signal(signal: NodeJS.Signals | 0, groups: Iterable<number> = this.groups): boolean {
    if (signal) this.signalled = true;
    let alive = false;
    for (const group of groups) {
      try {
        process.kill(-group, signal);
        alive = true;
      } catch (err) {
        // A member setup may not signal still holds its group.
        if ((err as NodeJS.ErrnoException).code === 'EPERM') alive = true;
      }
    }
    return alive;
  }

  /** Kills the whole tree at once; whether it was seen to end. Bounded: nothing can wait during 'exit'. */
  killAll(): boolean {
    const end = Date.now() + 1500;
    // Listed first, while a member without CODEX_HOME is still linked to its parent.
    this.take(listProcsSync(1500));
    this.signal('SIGKILL');
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let left = end - Date.now(); left > 0; left = end - Date.now()) {
      if (this.take(listProcsSync(Math.min(left, PS_TIMEOUT_MS)), () => 'SIGKILL') === false) return !this.blind;
      Atomics.wait(pause, 0, 0, 20);
    }
    return false;
  }

  private take(listing: Proc[] | string, signal?: () => NodeJS.Signals): boolean | undefined {
    if (typeof listing === 'string') {
      this.failure = listing;
      if (!this.signalled) this.blind ??= listing;
      return undefined;
    }
    this.failure = undefined;
    const own = listing.find((proc) => proc.pid === process.pid)?.pgid;
    const live = listing.filter((proc) => !proc.zombie);
    const tree = new Set<number>();
    for (let grew = true; grew;) {
      grew = false;
      for (const proc of live) {
        const ours = proc.pgid === this.leader || this.known.get(proc.pid) === proc.pgid || this.marks(proc);
        if (tree.has(proc.pid) || !(ours || tree.has(proc.ppid))) continue;
        tree.add(proc.pid);
        grew = true;
      }
    }
    const members = live.filter((proc) => tree.has(proc.pid));
    this.known = new Map(members.map((proc) => [proc.pid, proc.pgid]));
    const groups = [...new Set(members.map((proc) => proc.pgid))].filter((group) => group > 1 && group !== own);
    const found = groups.filter((group) => !this.groups.includes(group));
    this.groups = groups;
    if (signal) this.signal(signal(), found);
    return members.length > 0;
  }

  // A whole word: not OLD_CODEX_HOME=, nor another home that starts the same.
  private marks(proc: Proc): boolean {
    const { text } = proc;
    for (let at = text.indexOf(this.marker); at >= 0; at = text.indexOf(this.marker, at + 1)) {
      const end = at + this.marker.length;
      if ((at === 0 || text[at - 1] === ' ') && (end === text.length || text[end] === ' ')) return true;
    }
    return false;
  }
}

// Each row with its state (Z for a zombie), command line and, for the user's own processes, its environment.
const PS_ARGS = [
  '-U',
  String(process.getuid?.() ?? 0),
  '-ww',
  ...(process.platform === 'darwin'
    ? ['-E', '-o', 'pid=,ppid=,pgid=,stat=,command=']
    : ['-o', 'pid=,ppid=,pgid=,stat=,args=', 'e']),
];
const PS_BUFFER = 64 * 1024 * 1024;

/** The user's processes, from `ps`, or why they couldn't be listed. */
function listProcs(): Promise<Proc[] | string> {
  return new Promise((resolve) => {
    execFile('ps', PS_ARGS, { timeout: PS_TIMEOUT_MS, maxBuffer: PS_BUFFER }, (error, stdout) =>
      resolve(error ? psFailure(error) : parsePs(String(stdout))),
    );
  });
}

function listProcsSync(timeout: number): Proc[] | string {
  const ps = spawnSync('ps', PS_ARGS, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: PS_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (ps.error) return psFailure(ps.error);
  return ps.status === 0 ? parsePs(ps.stdout) : `ps exited with ${ps.status ?? ps.signal}`;
}

function psFailure(err: Error & { code?: unknown; killed?: boolean }): string {
  if (err.killed || err.code === 'ETIMEDOUT') return 'ps timed out';
  if (err.code === 'ENOENT') return 'ps not found';
  return `ps: ${err.message.split('\n')[0]}`;
}

function parsePs(stdout: string): Proc[] | string {
  const procs = stdout
    .trim()
    .split('\n')
    .map((row) => row.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/))
    .filter((m) => m !== null)
    .map((m) => ({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      zombie: m[4].startsWith('Z'),
      text: m[5],
    }));
  // A listing without setup in it isn't one to go by.
  return procs.some((proc) => proc.pid === process.pid) ? procs : 'ps gave an unreadable listing';
}

const LOGIN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const STOP_GRACE_MS = 3000;
const PS_TIMEOUT_MS = 2000;
const STALE_LOGIN_MS = 60 * 60 * 1000;

/**
 * A private throwaway CODEX_HOME under the install's git-ignored data/, not the
 * system temp dir: Codex won't set up its helper binaries there and warns on
 * every sign-in (#4449). A sign-in killed outright can't clean up and may leave
 * a token behind, so leftovers over an hour old go first.
 */
function makeLoginHome(root: string): string {
  const base = path.join(root, 'data', 'codex-login');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  fs.chmodSync(base, 0o700);
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_LOGIN_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove; the new home doesn't depend on it.
    }
  }
  return fs.mkdtempSync(path.join(base, 'login-'));
}

async function signIn(
  method: 'browser' | 'device',
  store: ProviderCredentialStore,
  root: string,
  loginHome: string,
  login: {
    onSpawn: (child: ChildProcess) => void;
    stop: (signal: NodeJS.Signals) => void;
    settled: () => Promise<void>;
  },
): Promise<void> {
  const cli = resolveCodexCli(root, loginHome);
  if (!cli.ok && 'stoppedBy' in cli) {
    // Stop as the queued signal would, with no error. The exit is a backstop
    // in case the re-raised signal doesn't end setup.
    login.stop(cli.stoppedBy);
    process.exit(1);
  }
  if (!cli.ok) {
    p.log.error(brandBody(cli.message));
    printInstallCommands(cli.install);
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'codex', METHOD: method, ERROR: cli.error });
    process.exit(1);
  }
  if (cli.pinned) {
    p.log.step(brandBody(`Preparing the pinned Codex CLI (${cli.pinned}) for sign-in…`));
    console.log(k.dim('   (no Codex CLI on this machine: pnpm fetches it once into its cache, no global install)'));
  }

  if (method === 'browser') {
    p.log.step(brandBody('Opening the Codex sign-in flow…'));
    console.log(k.dim('   (a browser will open for sign-in; this part is interactive)'));
  } else {
    p.log.step(brandBody('Starting Codex device-code pairing…'));
    console.log(k.dim('   (a URL and code will appear below — open the URL and enter the code)'));
  }
  console.log();

  const args = method === 'device' ? ['login', '--device-auth'] : ['login'];
  const start = Date.now();
  const { code, error } = await runInherit(cli.command, [...cli.prefix, ...args], {
    env: { CODEX_HOME: loginHome },
    onSpawn: login.onSpawn,
  });
  // Until the login's whole tree is gone: a stop for a signal then ends setup.
  await login.settled();
  const durationMs = Date.now() - start;
  console.log();

  if (code !== 0) {
    setupLog.step('auth', 'failed', durationMs, {
      PROVIDER: 'codex',
      METHOD: method,
      ...(error ? { ERROR: 'codex_spawn_failed', MESSAGE: error.message } : { EXIT_CODE: String(code) }),
      ...(cli.pinned ? { CLI: `pnpm dlx @openai/codex@${cli.pinned}` } : {}),
    });
    if (error) console.log(k.dim(`   ${error.message}`));
    if (!cli.pinned) {
      p.log.error(
        brandBody(
          "Couldn't complete the Codex sign-in. Re-run setup and try again, or choose the API key option instead.",
        ),
      );
      process.exit(1);
    }
    p.log.error(
      brandBody(
        `Couldn't complete the Codex sign-in with the pinned Codex CLI ${cli.pinned}. If pnpm couldn't start or fetch it (see above), check that this machine can reach the npm registry, or install the Codex CLI (below), then re-run setup in a new terminal — or choose the API key option instead.`,
      ),
    );
    printInstallCommands(codexInstallCommands(cli.pinned));
    process.exit(1);
  }

  const authJsonPath = path.join(loginHome, 'auth.json');
  if (!fs.existsSync(authJsonPath)) {
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: 'auth_json_not_found' });
    p.log.error(
      brandBody('Codex login succeeded but no auth.json was written. Try again, or paste an API key instead.'),
    );
    process.exit(1);
  }

  try {
    await store.save('codex', { kind: 'oauth', file: authJsonPath });
  } catch (err) {
    const message = storeFailureMessage(err);
    setupLog.step('auth', 'failed', durationMs, {
      PROVIDER: 'codex',
      METHOD: method,
      ERROR: 'gateway_store_failed',
      MESSAGE: message,
    });
    p.log.error(
      brandBody("Couldn't save your Codex credentials to the vault. Check the selected gateway, then retry."),
    );
    console.log(k.dim(`   ${message}`));
    process.exit(1);
  }
  setupLog.step('auth', 'success', durationMs, { PROVIDER: 'codex', METHOD: method });
  p.log.success(
    brandBody('OpenAI account connected — credentials live in your selected gateway, never in the container.'),
  );
}

/** OpenAI's installer first: npm works only where it can install globally. */
function printInstallCommands(install: string[]): void {
  console.log(k.dim("   Install the Codex CLI with OpenAI's installer (no sudo, into ~/.local/bin):"));
  console.log(`     ${install[0]}`);
  console.log(k.dim('   or with npm, if it can install globally:'));
  console.log(`     ${install[1]}`);
}

function runInherit(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; onSpawn?: (child: ChildProcess) => void } = {},
): Promise<{ code: number; error?: Error }> {
  return new Promise((resolve) => {
    // Its own session, so the login's tree stays apart from setup's process
    // group and can be stopped as a whole. The terminal's Ctrl-C and hangup
    // then reach setup alone, which stops the login.
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      detached: true,
    });
    opts.onSpawn?.(child);
    child.on('close', (code) => resolve({ code: code ?? 1 }));
    child.on('error', (error) => resolve({ code: 1, error }));
  });
}

// ─── failure assist ──────────────────────────────────────────────────────

/**
 * The Codex CLI can debug a setup failure only if the binary runs AND
 * ~/.codex/auth.json exists (API-key-only installs keep the key in the
 * OneCLI vault, so the host-side CLI has nothing to authenticate with).
 */
export function isCodexCliUsable(): boolean {
  const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (codexCheck.status !== 0) return false;
  return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
}

/**
 * Failure prompt handed to the interactive Codex session — same content as
 * the dispatcher's Claude system prompt: what failed, the job ("diagnose and
 * fix, be concise, exit when done"), and a de-duped file reference list.
 */
export function buildCodexFailurePrompt(ctx: AssistContext, projectRoot: string): string {
  const stepRefs = STEP_FILES[ctx.stepName] ?? [];
  const references = [
    ...BIG_PICTURE_FILES,
    ...stepRefs,
    'logs/setup.log',
    ctx.rawLogPath ? path.relative(projectRoot, ctx.rawLogPath) : 'logs/setup-steps/',
  ].filter((v, i, a) => a.indexOf(v) === i);

  const lines: string[] = [
    "The user is running NanoClaw's interactive setup flow and hit a failure.",
    '',
    `Failed step: ${ctx.stepName}`,
    `Error: ${ctx.msg}`,
  ];

  if (ctx.hint) lines.push(`Hint: ${ctx.hint}`);

  lines.push(
    '',
    'Your job: help them diagnose and fix this issue. Read the referenced files',
    'and logs to understand what went wrong, then help them fix it. You can read',
    'files, run commands, check logs, and explain what happened. Be concise.',
    "When they're ready to resume setup, tell them to exit Codex.",
    '',
    'Relevant files (read as needed):',
  );
  for (const f of references) lines.push(`  - ${f}`);

  return lines.join('\n');
}

/**
 * Registry hook: offer to debug a setup failure with the Codex CLI. Returns
 * 'unavailable' when the CLI can't run here so the dispatcher can fall back
 * to its guarded Claude offer.
 */
export async function offerCodexFailureAssist(ctx: AssistContext, projectRoot: string): Promise<FailureAssistResult> {
  if (!isCodexCliUsable()) return 'unavailable';

  const want = ensureAnswer(
    await p.confirm({
      message: 'Want to debug this with Codex?',
      initialValue: true,
    }),
  );
  if (!want) return 'declined';

  const prompt = buildCodexFailurePrompt(ctx, projectRoot);

  note(
    [
      'Launching Codex to help debug this failure.',
      'It has the context of what went wrong.',
      '',
      k.dim("Exit Codex (Ctrl-C or /quit) when you're ready to come back to setup."),
    ].join('\n'),
    'Handing off to Codex',
  );

  return new Promise<FailureAssistResult>((resolve) => {
    // codex accepts a positional initial prompt for the interactive TUI.
    // Commands run in a read-only sandbox; anything that needs more (a
    // write, the Docker socket, the service manager) asks first.
    const child = spawn('codex', ['--sandbox', 'read-only', '--ask-for-approval', 'on-request', prompt], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.on('close', () => {
      p.log.success(brandBody("Back from Codex. Let's continue."));
      resolve('launched');
    });
    child.on('error', () => {
      p.log.error("Couldn't launch Codex.");
      resolve('unavailable');
    });
  });
}

// ─── install verification ────────────────────────────────────────────────

/**
 * Verify the codex provider payload is fully wired — the same pre-flight the
 * /add-codex skill checks. A failed check means the install step should run
 * (or the user finishes via /add-codex).
 */
export function verifyCodexInstall(root = process.cwd()): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  const requiredFiles = [
    'src/providers/codex.ts',
    'src/providers/codex-agents-md.ts',
    'container/agent-runner/src/providers/codex.ts',
    'container/agent-runner/src/providers/codex-app-server.ts',
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of ['src/providers/index.ts', 'container/agent-runner/src/providers/index.ts']) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './codex.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const manifestPath = path.join(root, 'container', 'cli-tools.json');
  let hasCodexCli = false;
  if (fs.existsSync(manifestPath)) {
    try {
      const tools = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Array<{ name?: string }>;
      hasCodexCli = Array.isArray(tools) && tools.some((t) => t.name === '@openai/codex');
    } catch {
      hasCodexCli = false;
    }
  }
  if (!hasCodexCli) {
    problems.push('container/cli-tools.json missing the @openai/codex CLI entry');
  }

  return { ok: problems.length === 0, problems };
}

export async function runCodexInstallCheck(root = process.cwd()): Promise<void> {
  p.log.step(brandBody('Checking the Codex provider install…'));
  const { ok, problems } = verifyCodexInstall(root);
  if (ok) {
    setupLog.step('codex-install', 'success', 0, {});
    p.log.success(brandBody('Codex installed properly.'));
    return;
  }

  setupLog.step('codex-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The Codex provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent of choice: open Codex CLI or Claude Code in this repo and run the /add-codex skill.',
    ),
  );
  throw new Error(`Codex provider is not fully installed: ${problems.join('; ')}`);
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry — this call is codex's only reach-in to the setup
// flow (guarded by the barrel-driven registration test).
registerSetupProvider({
  value: 'codex',
  label: 'Codex',
  hint: 'OpenAI — ChatGPT subscription or API key',
  runAuth: runCodexAuthStep,
  runInstallCheck: runCodexInstallCheck,
  offerFailureAssist: offerCodexFailureAssist,
});
