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
  // The login runs in a session of its own (see runInherit). These are its
  // process groups while setup owns it; a stop first finds all of them.
  let groups: number[] = [];
  let known = false;
  let login: ChildProcess | undefined;
  let closed = false;
  let stopping: Promise<void> | undefined;
  let killNow = false;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const signalGroups = (signal: NodeJS.Signals | 0): boolean => {
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
  };
  // On the way out what is left of the login is killed outright: nothing can
  // wait during 'exit'.
  const release = (): void => {
    signalGroups('SIGKILL');
    removeLoginHome();
  };
  const detach = (): void => {
    process.off('exit', release);
    for (const signal of LOGIN_SIGNALS) process.off(signal, onSignal);
  };
  const finish = (signal: NodeJS.Signals): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    detach();
    removeLoginHome();
    process.kill(process.pid, signal);
  };
  // No signal reaches the login but this stop. Every group of its tree gets
  // SIGTERM, then SIGKILL after 3s or on a second signal, and the home goes
  // only once all of them are gone. The hooks stay attached until then.
  async function stopLogin(leader: number, signal: NodeJS.Signals): Promise<void> {
    // Before any signal: a member orphaned by its parent's exit can't be traced back.
    groups = await loginGroups(leader);
    known = true;
    signalGroups(killNow ? 'SIGKILL' : 'SIGTERM');
    timer = setTimeout(() => signalGroups('SIGKILL'), STOP_GRACE_MS);
    // Bounded, in case a member is never reaped.
    for (const end = Date.now() + STOP_GRACE_MS + 1000; signalGroups(0) && Date.now() < end;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    finish(signal);
  }
  function onSignal(signal: NodeJS.Signals): void {
    if (stopping) {
      // Not before the tree is known: the kill would orphan members it then can't find.
      killNow = true;
      if (known) signalGroups('SIGKILL');
      return;
    }
    if (!login?.pid || closed) return finish(signal);
    stopping = stopLogin(login.pid, signal);
  }
  const onSpawn = (child: ChildProcess): void => {
    login = child;
    if (child.pid) groups = [child.pid];
    child.once('close', (_code, signal) => {
      closed = true;
      // A login that exited by itself took Codex with it; what it leaves (a
      // browser it opened) isn't setup's. One killed by a signal may leave Codex,
      // which goes on the way out.
      if (!stopping && !signal) groups = [];
    });
  };
  process.on('exit', release);
  for (const signal of LOGIN_SIGNALS) process.on(signal, onSignal);
  try {
    await signIn(method, store, root, loginHome, { onSpawn, stop: onSignal, stopping: () => stopping });
  } finally {
    detach();
    release();
  }
}

/**
 * The process groups in the login's tree: its own, plus any a member moved to
 * (pnpm 12 runs Codex in a group of its own). Read from `ps`; without it, the
 * login's own group.
 */
function loginGroups(leader: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { timeout: 2000 }, (error, stdout) => {
      const rows = error
        ? []
        : String(stdout)
            .trim()
            .split('\n')
            .map((row) => row.trim().split(/\s+/).map(Number));
      const own = rows.find(([pid]) => pid === process.pid)?.[2];
      const tree = new Set([leader]);
      const found = new Set([leader]);
      for (let grew = true; grew;) {
        grew = false;
        for (const [pid, ppid, pgid] of rows) {
          if (tree.has(pid) || !tree.has(ppid)) continue;
          tree.add(pid);
          if (pgid > 1 && pgid !== own) found.add(pgid);
          grew = true;
        }
      }
      resolve([...found]);
    });
  });
}

const LOGIN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const STOP_GRACE_MS = 3000;
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
    stopping: () => Promise<void> | undefined;
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
  // A stop under way ends setup once the login's tree is gone, with nothing
  // printed. The exit backs up the re-raised signal.
  const stopped = login.stopping();
  if (stopped) {
    await stopped;
    process.exit(1);
  }
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
