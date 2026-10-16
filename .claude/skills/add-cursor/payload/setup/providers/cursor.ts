/**
 * Cursor provider setup — auth walk-through + install verification.
 *
 * Cursor-owned payload code: `/add-cursor` copies this in from the skill's
 * `payload/`. The only trunk reach-in is the `setup/providers/index.ts` barrel
 * import; the setup picker offers Cursor from the skill's own frontmatter.
 *
 * The long-lived key goes to the selected credential gateway, never `.env`:
 *   - Cursor account (the common case): a helper in the agent-runner package
 *     calls `Cursor.auth.login({ store: null })`, which mints an expiring user
 *     API key into a mode-0600 handoff file. Setup reads it, hands it to the
 *     gateway, and deletes the file.
 *   - API key: entered once in this local masked prompt (never chat).
 * The same key is stored for two routes: `api2.cursor.sh/auth/exchange_user_api_key`,
 * where the SDK swaps it for a short-lived runtime token, and
 * `api.cursor.com/v1/models`, for model discovery. The container only ever
 * sends the placeholder below.
 *
 * Do not import `@cursor/sdk` from setup — the login helper lives under
 * agent-runner so the SDK stays out of the host lockfile.
 */
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import {
  getCredentialStore,
  type GatewayCredentialConnection,
  type GatewayCredentialTarget,
} from '../gateways/credential-store.js';
import { brightSelect } from '../lib/bright-select.js';
import { brandBody } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { isPinnedBunVersion, pinnedBunVersion } from '../../scripts/provider-contract-verifier.js';
import { registerSetupProvider } from './registry.js';

/** Must equal `CURSOR_API_KEY_PLACEHOLDER` in src/providers/cursor.ts (a test keeps them in sync). */
export const CURSOR_CREDENTIAL_PLACEHOLDER = 'cursor_placeholder_nanoclaw';

const BEARER = { headerName: 'Authorization', valueFormat: 'Bearer {value}' };

// Not public SDK API: the @cursor/sdk 1.0.28 key-exchange and model-catalog
// routes. Re-verify both when bumping CURSOR_SDK_VERSION. The exchange is
// path-scoped because the SDK's RPCs to the same host carry the short-lived
// token it returns, which a host-wide entry would overwrite.
export const CURSOR_CREDENTIAL_TARGETS: readonly GatewayCredentialTarget[] = [
  {
    name: 'Cursor',
    kind: 'api-key',
    host: 'api2.cursor.sh',
    path: '/auth/exchange_user_api_key',
    proxyValue: CURSOR_CREDENTIAL_PLACEHOLDER,
    injection: BEARER,
  },
  {
    name: 'Cursor models',
    kind: 'api-key',
    host: 'api.cursor.com',
    path: '/v1/models',
    proxyValue: CURSOR_CREDENTIAL_PLACEHOLDER,
    injection: BEARER,
  },
];

/** `force` re-saves even when both entries exist (key rotation); the picker and provider-auth step never set it. */
export interface CursorAuthOptions {
  force?: boolean;
}

const CURSOR_LOGIN_HELPER = path.join('container', 'agent-runner', 'src', 'providers', 'cursor-auth.ts');
const CURSOR_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CURSOR_SDK_VERSION = '1.0.28';

export async function cursorCredentialConnections(root = process.cwd()): Promise<GatewayCredentialConnection[]> {
  const store = await getCredentialStore(root);
  if (!store.connection) throw new Error('The selected gateway does not support provider credential connections.');
  const connect = store.connection.bind(store);
  return CURSOR_CREDENTIAL_TARGETS.map((target) => connect(target));
}

/** True only when both entries exist and the gateway can keep them as they are. */
export async function cursorCredentialsConnected(connections: GatewayCredentialConnection[]): Promise<boolean> {
  for (const connection of connections) {
    if (!(await connection.find())?.reusable) return false;
  }
  return true;
}

/**
 * Store one key for both hosts. The seam cannot roll back a save, so a
 * failure after the first one says which entry already took the new key.
 */
export async function saveCursorKey(key: string, connections: GatewayCredentialConnection[]): Promise<void> {
  const value = key.trim();
  if (!value) throw new Error('Cannot save an empty Cursor key.');
  const saved: string[] = [];
  for (const [index, connection] of connections.entries()) {
    const name = CURSOR_CREDENTIAL_TARGETS[index]?.name ?? `entry ${index + 1}`;
    try {
      await connection.find();
      await connection.save(value);
    } catch (err) {
      if (saved.length === 0) throw err;
      throw new Error(
        `Saved the new key for ${saved.join(', ')}, but saving it for ${name} failed (${gatewayError(err)}). Re-run provider-auth; if it then reports Cursor as already connected while requests still fail, remove both Cursor entries in your gateway first.`,
      );
    }
    saved.push(name);
  }
}

/** The login helper runs under the container's pinned Bun, through pnpm when the host has no matching Bun. */
export function loginHelperCommand(root = process.cwd()): { command: string; prefix: string[] } {
  try {
    const version = execFileSync('bun', ['--version'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (isPinnedBunVersion(root, String(version).trim())) return { command: 'bun', prefix: [] };
  } catch {
    // No Bun on the host: use the pinned one below.
  }
  return { command: 'pnpm', prefix: [`--package=bun@${pinnedBunVersion(root)}`, 'dlx', 'bun'] };
}

/** Gateway adapters throw operator-facing messages; keep the first line only. */
function gatewayError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
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
  let connections: GatewayCredentialConnection[];
  let connected: boolean;
  try {
    connections = await cursorCredentialConnections();
    connected = await cursorCredentialsConnected(connections);
  } catch (err) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'cursor', ERROR: `gateway_lookup_failed: ${gatewayError(err)}` });
    p.log.error(brandBody(`Couldn't read the credential gateway before signing in to Cursor: ${gatewayError(err)}`));
    process.exit(1);
  }

  if (!options.force && connected) {
    try {
      // Lets the gateway finish anything an interrupted earlier save left undone.
      for (const connection of connections) await connection.keep();
    } catch (err) {
      setupLog.step('auth', 'failed', 0, { PROVIDER: 'cursor', ERROR: `gateway_keep_failed: ${gatewayError(err)}` });
      p.log.error(brandBody(`Couldn't confirm the stored Cursor key with the credential gateway: ${gatewayError(err)}`));
      process.exit(1);
    }
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
    p.log.warn(
      brandBody(
        'Cursor sign-in skipped. Run `pnpm exec tsx setup/index.ts --step provider-auth cursor` before using Cursor groups.',
      ),
    );
    return;
  }

  if (method === 'api') {
    await runCursorApiKeyAuth(connections);
    return;
  }

  await runCursorLoginAuth(method, connections);
}

async function runCursorApiKeyAuth(connections: GatewayCredentialConnection[]): Promise<void> {
  const key = ensureAnswer(
    await p.password({
      message: 'Enter your Cursor API key locally (cursor_… / crsr_… / key_…; never put it in chat)',
      clearOnError: true,
      validate: (v) => (v && looksLikeCursorApiKey(v) ? undefined : 'That does not look like a Cursor API key.'),
    }),
  ) as string;

  try {
    await saveCursorKey(key, connections);
  } catch (err) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'cursor', METHOD: 'api', ERROR: gatewayError(err) });
    p.log.error(brandBody(`Couldn't save your Cursor key to the credential gateway: ${gatewayError(err)}`));
    process.exit(1);
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'cursor', METHOD: 'api' });
  p.log.success(brandBody('Cursor account connected.'));
}

/** Read the helper's handoff file, refusing one that is missing, empty or not private. */
function readHandoffKey(keyPath: string): { key: string } | { error: 'handoff_missing' | 'handoff_insecure' } {
  try {
    if (!fs.existsSync(keyPath)) return { error: 'handoff_missing' };
    const stat = fs.statSync(keyPath);
    if (stat.size === 0) return { error: 'handoff_missing' };
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) return { error: 'handoff_insecure' };
    const key = fs.readFileSync(keyPath, 'utf-8').trim();
    return key ? { key } : { error: 'handoff_missing' };
  } catch {
    return { error: 'handoff_missing' };
  }
}

export async function runCursorLoginAuth(
  method: 'browser' | 'url',
  connections: GatewayCredentialConnection[],
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
  const helper = loginHelperCommand();
  const helperArgs = [...helper.prefix, CURSOR_LOGIN_HELPER, '--output', keyPath];
  if (method === 'url') helperArgs.push('--no-browser');
  let failure: { details: Record<string, string>; message: string } | undefined;
  try {
    const code = await runInherit(helper.command, helperArgs);
    if (code !== 0) {
      failure = {
        details: { EXIT_CODE: String(code) },
        message: "Couldn't complete the Cursor SDK sign-in. Re-run setup and try again.",
      };
    } else {
      const handoff = readHandoffKey(keyPath);
      if ('error' in handoff) {
        failure = {
          details: { ERROR: handoff.error },
          message:
            handoff.error === 'handoff_insecure'
              ? 'Cursor login wrote a credential file with unsafe permissions; it was deleted without saving.'
              : 'Cursor login succeeded but the secure handoff file was empty.',
        };
      } else {
        try {
          await saveCursorKey(handoff.key, connections);
        } catch (err) {
          failure = {
            details: { ERROR: gatewayError(err) },
            message: `Couldn't save your Cursor credentials to the credential gateway: ${gatewayError(err)}`,
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
      'Cursor account connected — the long-lived key is in your credential gateway; the SDK uses a short-lived runtime token inside the container. Browser-minted keys expire after 90 days.',
    ),
  );
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
