/**
 * Cursor provider setup — auth walk-through + install verification.
 *
 * Cursor-owned payload code: `/add-cursor` copies this in from the `providers`
 * branch. The only trunk reach-in is the `setup/providers/index.ts` barrel
 * import; the setup picker offers Cursor from the skill's own frontmatter.
 *
 * Auth keeps the long-lived credential in OneCLI — nothing lands in .env:
 *   - Cursor account (the common case): a helper in the agent-runner package
 *     calls `Cursor.auth.login({ store: null })`. The SDK mints an expiring
 *     user API key and writes it straight to a mode-0600 handoff file; OneCLI
 *     consumes it via `--file`, then setup deletes it. Two narrowly scoped
 *     vault rules use the same key: `api2.cursor.sh/auth/exchange_user_api_key`
 *     swaps it for a short-lived runtime token, while
 *     `api.cursor.com/v1/models` uses the original key for model discovery.
 *     Runtime calls keep using OneCLI as their proxy; the SDK sends its
 *     short-lived access token unchanged.
 *   - API key: entered once in this local masked prompt (never chat), written
 *     to the same kind of handoff file, and stored as the same generic secret.
 *
 * Session-isolation invariant: login is a host setup step; the container sends
 * placeholder `CURSOR_API_KEY` for the exchange, then holds only the returned
 * short-lived access token. Do not import `@cursor/sdk` from setup — the login
 * helper lives under agent-runner so the SDK stays out of the host lockfile.
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { brightSelect } from '../lib/bright-select.js';
import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { registerSetupProvider } from './registry.js';

// Not public SDK API — copied from the @cursor/sdk@1.0.28 key-exchange and
// model-catalog hosts. Re-verify both routes when bumping CURSOR_SDK_VERSION.
const CURSOR_HOST_PATTERN = 'api2.cursor.sh';
const CURSOR_PATH_PATTERN = '/auth/exchange_user_api_key';
const CURSOR_MODELS_HOST_PATTERN = 'api.cursor.com';
const CURSOR_MODELS_PATH_PATTERN = '/v1/models';
const CURSOR_SECRET_ROUTES = [
  {
    name: 'Cursor',
    hostPattern: CURSOR_HOST_PATTERN,
    pathPattern: CURSOR_PATH_PATTERN,
  },
  {
    name: 'Cursor models',
    hostPattern: CURSOR_MODELS_HOST_PATTERN,
    pathPattern: CURSOR_MODELS_PATH_PATTERN,
  },
] as const;
/** `force` re-vaults even when both routes exist (key rotation); the picker and provider-auth step never set it. */
export interface CursorAuthOptions {
  force?: boolean;
}

const CURSOR_LOGIN_HELPER = path.join('container', 'agent-runner', 'src', 'providers', 'cursor-auth.ts');
const CURSOR_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CURSOR_SDK_VERSION = '1.0.28';
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

function onecliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [LOCAL_BIN, process.env.PATH].filter(Boolean).join(path.delimiter),
  };
}

export interface OnecliSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
  pathPattern?: string | null;
}

export function listCursorSecrets(): OnecliSecret[] {
  const out = execFileSync('onecli', ['secrets', 'list'], {
    encoding: 'utf-8',
    env: onecliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out) as { data?: unknown };
  if (!Array.isArray(parsed.data)) throw new Error('OneCLI returned an invalid secret list');
  return parsed.data as OnecliSecret[];
}

export function findCursorSecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find((s) => {
    const hostPattern = (s.hostPattern ?? '').toLowerCase();
    return hostPattern === CURSOR_HOST_PATTERN && s.pathPattern === CURSOR_PATH_PATTERN;
  });
}

export function findCursorModelsSecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find((s) => {
    const hostPattern = (s.hostPattern ?? '').toLowerCase();
    return hostPattern === CURSOR_MODELS_HOST_PATTERN && s.pathPattern === CURSOR_MODELS_PATH_PATTERN;
  });
}

export function cursorSecretExists(): boolean {
  try {
    const secrets = listCursorSecrets();
    return findCursorSecret(secrets) !== undefined && findCursorModelsSecret(secrets) !== undefined;
  } catch {
    return false;
  }
}

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

/** Dashboard, service-account, and OAuth-minted user keys share these prefixes. */
export function looksLikeCursorApiKey(value: string): boolean {
  return /^(cursor_|crsr_|key_)[A-Za-z0-9._-]{8,}$/.test(value.trim());
}

export async function runCursorAuthStep(options: CursorAuthOptions = {}): Promise<void> {
  let secrets: OnecliSecret[];
  try {
    secrets = listCursorSecrets();
  } catch (err) {
    setupLog.step('auth', 'failed', 0, {
      PROVIDER: 'cursor',
      ERROR: `onecli_list_failed: ${String(err)}`,
    });
    p.log.error(
      brandBody(
        "Couldn't read the OneCLI vault. Make sure OneCLI is running (`onecli version`) before signing in to Cursor.",
      ),
    );
    process.exit(1);
  }

  if (!options.force && findCursorSecret(secrets) && findCursorModelsSecret(secrets)) {
    p.log.success(brandBody('Your Cursor account is already connected.'));
    setupLog.step('auth', 'skipped', 0, { REASON: 'cursor-secret-already-present', PROVIDER: 'cursor' });
    return;
  }

  const method = ensureAnswer(
    await brightSelect<'browser' | 'url' | 'api' | 'skip'>({
      message: 'How would you like to connect Cursor?',
      options: [
        {
          value: 'browser',
          label: 'Sign in with my Cursor account',
          hint: 'recommended — opens a browser, mints a user API key',
        },
        {
          value: 'url',
          label: 'Sign in with a URL',
          hint: 'no browser handoff — prints a URL to complete on another machine',
        },
        {
          value: 'api',
          label: 'Paste a Cursor API key',
          hint: 'from cursor.com/dashboard/api, or a leftover OAuth-minted key',
        },
        {
          value: 'skip',
          label: "Skip — I'll connect later",
          hint: 'Cursor groups will start, but model calls will fail auth',
        },
      ],
    }),
  );
  setupLog.userInput('cursor_auth_method', method);

  if (method === 'skip') {
    const confirmed = ensureAnswer(
      await p.confirm({
        message: "Skip Cursor sign-in? Cursor won't be able to answer until you connect an account.",
        initialValue: false,
      }),
    );
    if (!confirmed) return runCursorAuthStep(options);
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped', PROVIDER: 'cursor' });
    p.log.warn(brandBody('Cursor sign-in skipped. Add a Cursor secret to OneCLI before using Cursor groups.'));
    return;
  }

  if (method === 'api') {
    await runCursorApiKeyAuth(options.force === true);
    return;
  }

  await runCursorLoginAuth(method, { replaceExisting: options.force === true });
}

async function runCursorApiKeyAuth(replaceExisting: boolean): Promise<void> {
  const key = ensureAnswer(
    await p.password({
      message: 'Enter your Cursor API key locally (cursor_… / crsr_… / key_…; never put it in chat)',
      clearOnError: true,
      validate: (v) => (v && looksLikeCursorApiKey(v) ? undefined : 'That does not look like a Cursor API key.'),
    }),
  ) as string;

  try {
    vaultCursorKey(key.trim(), { replaceExisting });
  } catch (err) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'cursor', METHOD: 'api', ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your Cursor key to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'cursor', METHOD: 'api' });
  p.log.success(brandBody('Cursor account connected.'));
}

export async function runCursorLoginAuth(
  method: 'browser' | 'url',
  options: { replaceExisting?: boolean } = {},
): Promise<void> {
  if (method === 'browser') {
    p.log.step(brandBody('Opening the Cursor SDK sign-in flow…'));
    console.log(k.dim('   (a browser will open; the SDK mints a scoped, expiring NanoClaw API key)'));
  } else {
    p.log.step(brandBody('Starting Cursor SDK URL sign-in…'));
    console.log(k.dim('   (a URL will appear below — open it on any machine and complete sign-in)'));
  }
  console.log();

  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-vault-login-'));
  fs.chmodSync(handoffDir, 0o700);
  const keyPath = path.join(handoffDir, 'api-key');
  const removeHandoff = (): void => fs.rmSync(handoffDir, { recursive: true, force: true });

  const start = Date.now();
  const helperArgs = [CURSOR_LOGIN_HELPER, '--output', keyPath];
  if (method === 'url') helperArgs.push('--no-browser');
  let failure: { details: Record<string, string>; message: string } | undefined;
  try {
    const code = await runInherit('bun', helperArgs);
    if (code !== 0) {
      failure = {
        details: { EXIT_CODE: String(code) },
        message: "Couldn't complete the Cursor SDK sign-in. Re-run setup and try again.",
      };
    } else {
      let handoffError: 'handoff_missing' | 'handoff_insecure' | undefined;
      try {
        if (!fs.existsSync(keyPath)) {
          handoffError = 'handoff_missing';
        } else {
          const stat = fs.statSync(keyPath);
          if (stat.size === 0) handoffError = 'handoff_missing';
          else if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
            handoffError = 'handoff_insecure';
          }
        }
      } catch {
        handoffError = 'handoff_missing';
      }
      if (handoffError) {
        failure = {
          details: { ERROR: handoffError },
          message:
            handoffError === 'handoff_insecure'
              ? 'Cursor login wrote a credential file with unsafe permissions; it was deleted without vaulting.'
              : 'Cursor login succeeded but the secure vault handoff was empty.',
        };
      } else {
        try {
          vaultCursorKeyFile(keyPath, options);
        } catch (err) {
          failure = {
            details: { ERROR: String(err) },
            message:
              "Couldn't save your Cursor credentials to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
          };
        }
      }
    }
  } catch (err) {
    failure = {
      details: { ERROR: String(err) },
      message: "Couldn't complete the Cursor SDK sign-in. Re-run setup and try again.",
    };
  } finally {
    removeHandoff();
  }
  const durationMs = Date.now() - start;
  console.log();

  if (failure) {
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'cursor', METHOD: method, ...failure.details });
    p.log.error(brandBody(failure.message));
    process.exit(1);
  }

  setupLog.step('auth', 'success', durationMs, { PROVIDER: 'cursor', METHOD: method });
  p.log.success(
    brandBody(
      'Cursor account connected — the long-lived credential is in your OneCLI vault; the SDK uses a short-lived runtime token inside the container. Browser-minted keys expire after 90 days.',
    ),
  );
}

export function vaultCursorKey(key: string, options: { replaceExisting?: boolean } = {}): void {
  const handoffDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-vault-key-'));
  fs.chmodSync(handoffDir, 0o700);
  const keyPath = path.join(handoffDir, 'api-key');
  try {
    fs.writeFileSync(keyPath, key, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    vaultCursorKeyFile(keyPath, options);
  } finally {
    fs.rmSync(handoffDir, { recursive: true, force: true });
  }
}

function routeMatches(secret: OnecliSecret, route: (typeof CURSOR_SECRET_ROUTES)[number]): boolean {
  return (secret.hostPattern ?? '').toLowerCase() === route.hostPattern && secret.pathPattern === route.pathPattern;
}

function createdSecretId(out: string): string {
  const parsed = JSON.parse(out) as { id?: unknown };
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new Error('OneCLI created a secret but returned no id');
  }
  return parsed.id;
}

function deleteSecretBestEffort(id: string): void {
  try {
    execFileSync('onecli', ['secrets', 'delete', '--id', id], {
      env: onecliEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Preserve the original create failure. A later rerun sees the surviving
    // exact route and fills only what is still missing.
  }
}

function deleteSecret(id: string): void {
  execFileSync('onecli', ['secrets', 'delete', '--id', id], {
    env: onecliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Create only missing Cursor routes and roll back entries created by this call
 * if a later route fails. Existing working routes are never deleted.
 */
export function vaultCursorKeyFile(keyPath: string, options: { replaceExisting?: boolean } = {}): string[] {
  const existing = listCursorSecrets();
  const knownIds = new Set(existing.map((secret) => secret.id));
  const createdIds: string[] = [];

  try {
    for (const route of CURSOR_SECRET_ROUTES) {
      if (!options.replaceExisting && existing.some((secret) => routeMatches(secret, route))) continue;
      const out = execFileSync(
        'onecli',
        [
          'secrets',
          'create',
          '--name',
          route.name,
          '--type',
          'generic',
          '--file',
          keyPath,
          '--host-pattern',
          route.hostPattern,
          '--path-pattern',
          route.pathPattern,
          '--header-name',
          'Authorization',
          '--value-format',
          'Bearer {value}',
        ],
        {
          encoding: 'utf-8',
          env: onecliEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      try {
        createdIds.push(createdSecretId(out));
      } catch (err) {
        // Reconcile malformed CLI output so a secret that was created before
        // stdout was corrupted can still be removed transactionally.
        try {
          for (const secret of listCursorSecrets()) {
            if (!knownIds.has(secret.id) && routeMatches(secret, route)) createdIds.push(secret.id);
          }
        } catch {
          // The original malformed response remains the actionable failure.
        }
        throw err;
      }
    }
  } catch (err) {
    for (const id of [...createdIds].reverse()) deleteSecretBestEffort(id);
    throw err;
  }

  if (options.replaceExisting) {
    const staleIds = existing
      .filter((secret) => CURSOR_SECRET_ROUTES.some((route) => routeMatches(secret, route)))
      .map((secret) => secret.id);
    const failedDeletes: string[] = [];
    for (const id of staleIds) {
      try {
        deleteSecret(id);
      } catch {
        failedDeletes.push(id);
      }
    }
    if (failedDeletes.length > 0) {
      // Keep the newly created routes. Rolling them back after some old routes
      // were already deleted could leave Cursor with no complete credential.
      throw new Error(
        `Cursor credentials were rotated, but ${failedDeletes.length} stale OneCLI secret(s) could not be deleted; retry --force`,
      );
    }
  }
  return createdIds;
}

export function runInherit(
  cmd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
  timeoutMs = CURSOR_LOGIN_TIMEOUT_MS,
  signalSource: Pick<NodeJS.Process, 'once' | 'off'> = process,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let settled = false;
    let timer: NodeJS.Timeout;
    let finish: (code: number) => void;
    const stop = (code: number): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // The child may already have exited; finish still resolves setup.
      }
      finish(code);
    };
    const onSigint = (): void => stop(130);
    const onSigterm = (): void => stop(143);
    finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signalSource.off('SIGINT', onSigint);
      signalSource.off('SIGTERM', onSigterm);
      resolve(code);
    };
    timer = setTimeout(() => stop(124), timeoutMs);
    timer.unref?.();
    signalSource.once('SIGINT', onSigint);
    signalSource.once('SIGTERM', onSigterm);
    child.once('close', (code) => finish(code ?? 1));
    child.once('error', () => finish(1));
  });
}

/** The five barrels `/add-cursor` appends `import './cursor.js';` to. */
export const CURSOR_BARRELS = [
  'src/providers/index.ts',
  'src/provider-contracts/index.ts',
  'container/agent-runner/src/providers/index.ts',
  'container/agent-runner/src/provider-contracts/index.ts',
  'setup/providers/index.ts',
] as const;

export function verifyCursorInstall(root = process.cwd()): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  const requiredFiles = [
    'src/providers/cursor.ts',
    'src/provider-contracts/cursor.ts',
    'container/agent-runner/src/providers/cursor.ts',
    'container/agent-runner/src/providers/cursor-auth.ts',
    'container/agent-runner/src/providers/cursor-hook.ts',
    'container/agent-runner/src/providers/cursor.conformance.test.ts',
    'container/agent-runner/src/provider-contracts/cursor.ts',
    'setup/providers/cursor.ts',
  ];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(root, file))) problems.push(`missing file: ${file}`);
  }

  for (const barrel of CURSOR_BARRELS) {
    const barrelPath = path.join(root, barrel);
    if (!fs.existsSync(barrelPath) || !fs.readFileSync(barrelPath, 'utf-8').includes("import './cursor.js';")) {
      problems.push(`missing barrel import in ${barrel}`);
    }
  }

  const pkgPath = path.join(root, 'container', 'agent-runner', 'package.json');
  let hasSdk = false;
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
      };
      const pin = pkg.dependencies?.['@cursor/sdk'];
      hasSdk = pin === CURSOR_SDK_VERSION;
    } catch {
      hasSdk = false;
    }
  }
  if (!hasSdk) {
    problems.push(`container/agent-runner/package.json must pin @cursor/sdk exactly to ${CURSOR_SDK_VERSION}`);
  }

  const lockPath = path.join(root, 'container', 'agent-runner', 'bun.lock');
  let lockHasSdk = false;
  if (fs.existsSync(lockPath)) {
    try {
      const lock = fs.readFileSync(lockPath, 'utf-8');
      lockHasSdk = new RegExp(`"@cursor/sdk"\\s*:\\s*"${CURSOR_SDK_VERSION.replace(/\./g, '\\.')}"`).test(lock);
    } catch {
      lockHasSdk = false;
    }
  }
  if (!lockHasSdk) {
    problems.push(`container/agent-runner/bun.lock must resolve @cursor/sdk ${CURSOR_SDK_VERSION}`);
  }

  const hostPkgPath = path.join(root, 'package.json');
  if (fs.existsSync(hostPkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(hostPkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.dependencies?.['@cursor/sdk'] || pkg.devDependencies?.['@cursor/sdk']) {
        problems.push('@cursor/sdk must not be installed in the host pnpm package');
      }
    } catch {
      problems.push('host package.json is unreadable');
    }
  }

  const manifestPath = path.join(root, 'container', 'cli-tools.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const tools = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Array<{ name?: string }>;
      if (Array.isArray(tools) && tools.some((t) => t.name === '@cursor/sdk' || t.name === 'cursor-agent')) {
        problems.push('container/cli-tools.json should not list a Cursor CLI — the container uses the SDK');
      }
    } catch {
      /* ignore unreadable manifest */
    }
  }

  return { ok: problems.length === 0, problems };
}

export async function runCursorInstallCheck(root = process.cwd()): Promise<void> {
  p.log.step(brandBody('Checking the Cursor provider install…'));
  const { ok, problems } = verifyCursorInstall(root);
  if (ok) {
    setupLog.step('cursor-install', 'success', 0, {});
    p.log.success(brandBody('Cursor installed properly.'));
    return;
  }

  setupLog.step('cursor-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  p.log.warn(brandBody('The Cursor provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent of choice: open this repo and run the /add-cursor skill, then retry setup.',
    ),
  );
  throw new Error(`Cursor provider install is incomplete: ${problems.join('; ')}`);
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry. `label` and `hint` must match the
// `nanoclaw-provider-label` / `-hint` frontmatter of .claude/skills/add-cursor
// (a trunk test keeps the pair in sync).
registerSetupProvider({
  value: 'cursor',
  label: 'Cursor',
  hint: 'Cursor — account sign-in or API key',
  runAuth: () => runCursorAuthStep(),
  runInstallCheck: runCursorInstallCheck,
});
