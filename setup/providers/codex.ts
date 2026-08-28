/**
 * Codex provider setup — auth walk-through + install verification.
 *
 * Codex-owned payload code: when the codex provider moves to the `providers`
 * branch, this file travels with it and `/add-codex` copies it back in. The
 * only trunk reach-in is one import + one picker entry in setup/auto.ts.
 *
 * Auth honors the v2 credential invariant — everything lands in the OneCLI
 * vault, nothing in .env, nothing in the container:
 *   - ChatGPT subscription (the common case): `codex login` (browser) or
 *     `codex login --device-auth` (URL + pairing code) runs with CODEX_HOME
 *     pointed at a throwaway dir; the auth.json written there is stored
 *     WHOLE in the vault (`--file … --host-pattern chatgpt.com`) and the dir
 *     is deleted. The gateway injects it in flight; the container only ever
 *     sees the `onecli-managed` placeholder.
 *   - API key: pasted once, stored as an `openai` secret for api.openai.com.
 *
 * Session-isolation invariant: the vaulted ChatGPT session must be DEDICATED
 * to the gateway. Never vault a copy of the user's live ~/.codex/auth.json.
 * OpenAI rotates refresh tokens, so two consumers sharing one OAuth session
 * strand each other on refresh, and replaying the stale token trips reuse
 * detection — which invalidates the whole session family server-side
 * (`token_invalidated`) for the gateway AND the user's personal Codex CLI.
 */
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { type AssistContext, BIG_PICTURE_FILES, STEP_FILES } from '../lib/claude-assist.js';
import { machineChildEnvironment, runInteractiveProcess } from '../lib/interactive-process.js';
import { registerSensitiveValue } from '../lib/redaction.js';
import { withSecretFile } from '../lib/secret-file.js';
import { type SetupDriver } from '../lib/setup-driver.js';
import { brandBody, note } from '../lib/theme.js';
import * as setupLog from '../logs.js';
import { type FailureAssistResult, registerSetupProvider } from './registry.js';

// ─── OneCLI vault helpers ────────────────────────────────────────────────

interface OnecliSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
}

function listSecrets(): OnecliSecret[] {
  const out = execFileSync('onecli', ['secrets', 'list'], { encoding: 'utf-8' });
  return parseSecrets(out);
}

function parseSecrets(out: string): OnecliSecret[] {
  const parsed = JSON.parse(out) as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data as OnecliSecret[]) : [];
}

function findOpenAISecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find((s) => {
    const name = s.name.toLowerCase();
    const type = s.type.toLowerCase();
    const hostPattern = (s.hostPattern ?? '').toLowerCase();
    return (
      name === 'codex' ||
      name === 'openai' ||
      type === 'openai' ||
      hostPattern.includes('api.openai.com') ||
      hostPattern.includes('chatgpt.com')
    );
  });
}

async function openAISecretExists(driver: SetupDriver): Promise<boolean> {
  if (driver.mode === 'terminal') {
    try {
      return findOpenAISecret(listSecrets()) !== undefined;
    } catch {
      return false;
    }
  }

  let output = '';
  try {
    const result = await runInteractiveProcess(driver, 'onecli', ['secrets', 'list'], {
      env: machineChildEnvironment(),
      timeoutMs: VAULT_TIMEOUT_MS,
      onOutput(chunk) {
        output += chunk;
      },
    });
    return result.reason === 'exited' && result.exitCode === 0 && findOpenAISecret(parseSecrets(output)) !== undefined;
  } catch {
    driver.throwIfCancelled();
    return false;
  }
}

// ─── auth step ───────────────────────────────────────────────────────────

function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(1);
  }
  return value as T;
}

export async function runCodexAuthStep(driver: SetupDriver): Promise<void> {
  if (await openAISecretExists(driver)) {
    driver.log('success', brandBody('Your OpenAI account is already connected.'));
    setupLog.step('auth', 'skipped', 0, { REASON: 'openai-secret-already-present', PROVIDER: 'codex' });
    return;
  }

  const answer = await driver.prompt({
    id: 'codex-auth-method',
    kind: 'singleChoice',
    message: 'How would you like to connect Codex?',
    choices: [
      {
        id: 'browser',
        label: 'Sign in with my ChatGPT subscription',
        hint: 'recommended if you have Plus or Pro — opens a browser',
      },
      {
        id: 'device',
        label: 'ChatGPT device pairing',
        hint: 'no browser handoff — shows a URL and a code',
      },
      {
        id: 'api',
        label: 'Paste an OpenAI API key',
        hint: 'pay-per-use; stored in OneCLI, never copied into the container',
      },
      {
        id: 'skip',
        label: "Skip — I'll connect later",
        hint: 'Codex groups will start, but model calls will fail auth',
      },
    ],
  });
  let method: 'browser' | 'device' | 'api' | 'skip';
  switch (answer) {
    case 'browser':
    case 'device':
    case 'api':
    case 'skip':
      method = answer;
      break;
    default:
      driver.error('codex_auth_method_invalid', 'Unknown Codex authentication method.', [], 'auth');
  }
  setupLog.userInput('codex_auth_method', method);

  if (method === 'skip') {
    const confirmed = await driver.prompt({
      id: 'codex-auth-skip-confirm',
      kind: 'confirm',
      message: "Skip Codex sign-in? Codex won't be able to answer until you connect an OpenAI account.",
      default: false,
    });
    if (!confirmed) return runCodexAuthStep(driver);
    setupLog.step('auth', 'skipped', 0, { REASON: 'user-skipped', PROVIDER: 'codex' });
    driver.log('warn', brandBody('Codex sign-in skipped. Add an OpenAI account to OneCLI before using Codex groups.'));
    return;
  }

  if (method === 'api') {
    await runCodexApiKeyAuth(driver);
    return;
  }

  await runCodexLoginAuth(driver, method);
}

async function runCodexApiKeyAuth(driver: SetupDriver): Promise<void> {
  const key = String(
    await driver.prompt({
      id: 'codex-api-key',
      kind: 'secret',
      message: 'Paste your OpenAI API key (sk-…)',
      validateValue: (value) =>
        String(value).trim().startsWith('sk-') ? undefined : 'That does not look like an OpenAI API key.',
    }),
  ).trim();
  registerSensitiveValue(key);
  driver.progress('codex-auth', 'running', 'Saving OpenAI credentials');

  // The key reaches OneCLI through a private one-use file in both renderers;
  // it never appears in argv.
  const args = (filePath: string): string[] => [
    'secrets',
    'create',
    '--name',
    'Codex',
    '--type',
    'openai',
    '--file',
    filePath,
    '--host-pattern',
    'api.openai.com',
  ];
  const ok = await withSecretFile(key, (filePath) => runVaultCommand(driver, args(filePath)));
  if (!ok) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'codex', METHOD: 'api', ERROR: 'vault_create_failed' });
    driver.log(
      'error',
      brandBody(
        "Couldn't save your OpenAI key to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
      ),
    );
    driver.progress('codex-auth', 'failed');
    if (driver.mode === 'terminal') process.exit(1);
    driver.error(
      'codex_vault_failed',
      "Couldn't save your OpenAI key to the vault.",
      [{ kind: 'rerun', args: ['--protocol', 'nanoclaw.driver.v1'] }],
      'auth',
    );
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'codex', METHOD: 'api' });
  driver.progress('codex-auth', 'succeeded');
  driver.log('success', brandBody('OpenAI account connected.'));
}

const MAX_CODEX_AUTH_OUTPUT_BYTES = 64 * 1024;
const AUTH_JSON_MAX_BYTES = 1024 * 1024;
const CODEX_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const CODEX_STATUS_TIMEOUT_MS = 30 * 1000;
const VAULT_TIMEOUT_MS = 2 * 60 * 1000;

class CodexOutputFailure extends Error {
  constructor(readonly reason: 'provider_output_limit') {
    super(reason);
  }
}

function machineLoginEnvironment(loginRoot: string, codexHome: string): NodeJS.ProcessEnv {
  return machineChildEnvironment({
    HOME: path.join(loginRoot, 'home'),
    CODEX_HOME: codexHome,
    XDG_CACHE_HOME: path.join(loginRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(loginRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(loginRoot, 'xdg-data'),
    XDG_STATE_HOME: path.join(loginRoot, 'xdg-state'),
  });
}

function createPrivateDirectories(paths: string[]): void {
  for (const directory of paths) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readValidCodexAuth(authJsonPath: string): boolean {
  try {
    const stat = fs.lstatSync(authJsonPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > AUTH_JSON_MAX_BYTES) return false;
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) return false;
    const parsed: unknown = JSON.parse(fs.readFileSync(authJsonPath, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.tokens)) return false;
    const tokens = parsed.tokens;
    const values = ['access_token', 'refresh_token', 'id_token']
      .map((key) => tokens[key])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const value of values) registerSensitiveValue(value);
    return values.length > 0;
  } catch {
    return false;
  }
}

function allowedCodexUrl(value: string, method: 'browser' | 'device'): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') return undefined;
    if (method === 'browser' && url.pathname !== '/oauth/authorize') return undefined;
    if (method === 'device' && !['/codex/device', '/codex/device/'].includes(url.pathname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function createCodexOutputHandler(
  driver: SetupDriver,
  method: 'browser' | 'device',
): {
  onOutput(chunk: string, stream: 'stdout' | 'stderr'): Promise<void>;
  valid(): boolean;
} {
  const output = { stdout: '', stderr: '' };
  const urls = new Set<string>();
  const codes = new Set<string>();
  let authPresented = false;
  let isMalformed = false;

  const onOutput = async (chunk: string, _stream: 'stdout' | 'stderr'): Promise<void> => {
    const outputBytes = Buffer.byteLength(output.stdout, 'utf8') + Buffer.byteLength(output.stderr, 'utf8');
    if (outputBytes + Buffer.byteLength(chunk, 'utf8') > MAX_CODEX_AUTH_OUTPUT_BYTES) {
      isMalformed = true;
      throw new CodexOutputFailure('provider_output_limit');
    }
    output[_stream] += chunk;
    const completeOutput = output[_stream].slice(
      0,
      Math.max(output[_stream].lastIndexOf('\n'), output[_stream].lastIndexOf('\r')) + 1,
    );
    for (const match of completeOutput.matchAll(/https:\/\/auth\.openai\.com\/[^\s<>"']{1,8192}/g)) {
      const url = allowedCodexUrl(match[0], method);
      if (url) urls.add(url);
    }
    if (method === 'device') {
      const withoutUrls = completeOutput.replace(/https:\/\/[^\s<>"']+/g, ' ');
      for (const match of withoutUrls.matchAll(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g)) codes.add(match[0]);
    }
    if (authPresented || urls.size !== 1 || (method === 'device' && codes.size !== 1)) return;

    const url = [...urls][0];
    registerSensitiveValue(url);
    driver.display({ id: 'codex-auth-url', kind: 'url', url, label: 'Codex sign-in', sensitive: true });
    if (method === 'device') {
      const code = [...codes][0];
      registerSensitiveValue(code);
      driver.display({
        id: 'codex-device-code',
        kind: 'code',
        content: code,
        label: 'Codex pairing code',
        sensitive: true,
      });
    }
    authPresented = true;
  };

  return {
    onOutput,
    valid: () => !isMalformed && authPresented && urls.size === 1 && (method === 'browser' || codes.size === 1),
  };
}

async function hasAuthenticatedCodexSession(driver: SetupDriver, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (driver.mode === 'terminal') {
    const result = spawnSync('codex', ['login', 'status'], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status === 0;
  }
  const result = await runInteractiveProcess(driver, 'codex', ['login', 'status'], {
    env,
    timeoutMs: CODEX_STATUS_TIMEOUT_MS,
  });
  return result.reason === 'exited' && result.exitCode === 0;
}

async function runVaultCommand(driver: SetupDriver, args: string[]): Promise<boolean> {
  if (driver.mode === 'terminal') {
    try {
      execFileSync('onecli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }
  const result = await runInteractiveProcess(driver, 'onecli', args, {
    env: machineChildEnvironment(),
    timeoutMs: VAULT_TIMEOUT_MS,
  });
  return result.reason === 'exited' && result.exitCode === 0;
}

export async function runCodexLoginAuth(driver: SetupDriver, method: 'browser' | 'device'): Promise<void> {
  if (driver.mode === 'terminal') {
    const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (codexCheck.status !== 0) {
      driver.log(
        'error',
        brandBody(
          'The Codex CLI is not installed on this machine. Install it with `npm install -g @openai/codex`, then re-run setup — or choose the API key option instead.',
        ),
      );
      setupLog.step('auth', 'failed', 0, { PROVIDER: 'codex', METHOD: method, ERROR: 'codex_cli_missing' });
      process.exit(1);
    }
  }

  if (method === 'browser') {
    driver.log('step', brandBody('Opening the Codex sign-in flow…'));
    if (driver.mode === 'terminal')
      console.log(k.dim('   (a browser will open for sign-in; this part is interactive)'));
  } else {
    driver.log('step', brandBody('Starting Codex device-code pairing…'));
    if (driver.mode === 'terminal')
      console.log(k.dim('   (a URL and code will appear below — open the URL and enter the code)'));
  }
  if (driver.mode === 'terminal') console.log();

  // Session-isolation invariant (see file header): the login runs under a
  // throwaway CODEX_HOME so the vaulted session is dedicated to the gateway
  // and never shared with the user's personal ~/.codex.
  const loginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-login-'));
  fs.chmodSync(loginRoot, 0o700);
  const codexHome = driver.mode === 'terminal' ? loginRoot : path.join(loginRoot, 'codex-home');
  if (driver.mode === 'ndjson') {
    createPrivateDirectories([
      codexHome,
      path.join(loginRoot, 'home'),
      path.join(loginRoot, 'xdg-cache'),
      path.join(loginRoot, 'xdg-config'),
      path.join(loginRoot, 'xdg-data'),
      path.join(loginRoot, 'xdg-state'),
    ]);
  }
  const authJsonPath = path.join(codexHome, 'auth.json');
  const loginEnv =
    driver.mode === 'terminal' ? { CODEX_HOME: codexHome } : machineLoginEnvironment(loginRoot, codexHome);
  const removeLoginRoot = (): void => fs.rmSync(loginRoot, { recursive: true, force: true });

  const args = method === 'device' ? ['login', '--device-auth'] : ['login'];
  const start = Date.now();
  try {
    driver.progress('codex-auth', 'running', 'Waiting for Codex sign-in');
    const output = createCodexOutputHandler(driver, method);
    let result: Awaited<ReturnType<typeof runInteractiveProcess>> | { reason: 'provider_output_limit' };
    try {
      result = await runInteractiveProcess(driver, 'codex', args, {
        timeoutMs: CODEX_LOGIN_TIMEOUT_MS,
        env: loginEnv,
        ...(driver.mode === 'ndjson' ? { onOutput: output.onOutput } : {}),
      });
    } catch (error) {
      driver.throwIfCancelled();
      if (!(error instanceof CodexOutputFailure)) throw error;
      result = { reason: error.reason };
    }
    const durationMs = Date.now() - start;
    if (driver.mode === 'terminal') console.log();

    if (result.reason !== 'exited' || result.exitCode !== 0 || (driver.mode === 'ndjson' && !output.valid())) {
      const reason =
        result.reason === 'exited'
          ? result.exitCode === 0
            ? 'invalid_provider_output'
            : `exit_${result.exitCode}`
          : result.reason;
      setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: reason });
      driver.progress('codex-auth', 'failed');
      driver.log(
        'error',
        brandBody(
          "Couldn't complete the Codex sign-in. Re-run setup and try again, or choose the API key option instead.",
        ),
      );
      if (driver.mode === 'terminal') {
        removeLoginRoot();
        process.exit(1);
      }
      driver.error(
        'codex_login_failed',
        "Couldn't complete the Codex sign-in.",
        [{ kind: 'rerun', args: ['--protocol', 'nanoclaw.driver.v1'] }],
        'auth',
      );
    }

    if (!readValidCodexAuth(authJsonPath)) {
      setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: 'invalid_auth_json' });
      driver.progress('codex-auth', 'failed');
      driver.log(
        'error',
        brandBody(
          'Codex login succeeded but no valid private auth.json was written. Try again, or paste an API key instead.',
        ),
      );
      if (driver.mode === 'terminal') {
        removeLoginRoot();
        process.exit(1);
      }
      driver.error(
        'codex_auth_file_invalid',
        'Codex login did not produce a valid private auth.json.',
        [{ kind: 'rerun', args: ['--protocol', 'nanoclaw.driver.v1'] }],
        'auth',
      );
    }

    if (!(await hasAuthenticatedCodexSession(driver, loginEnv))) {
      setupLog.step('auth', 'failed', durationMs, {
        PROVIDER: 'codex',
        METHOD: method,
        ERROR: 'provider_status_unverified',
      });
      driver.progress('codex-auth', 'failed');
      if (driver.mode === 'terminal') {
        driver.log(
          'error',
          brandBody(
            'Codex did not confirm that the isolated session is authenticated. Re-run setup and sign in again, or choose the API key option instead.',
          ),
        );
        removeLoginRoot();
        process.exit(1);
      }
      driver.error(
        'codex_login_status_failed',
        'Codex did not confirm that the isolated session is authenticated.',
        [{ kind: 'rerun', args: ['--protocol', 'nanoclaw.driver.v1'] }],
        'auth',
      );
    }

    const vaulted = await runVaultCommand(driver, [
      'secrets',
      'create',
      '--name',
      'Codex',
      '--type',
      'openai',
      '--file',
      authJsonPath,
      '--host-pattern',
      'chatgpt.com',
    ]);
    if (!vaulted) {
      setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: 'vault_create_failed' });
      driver.progress('codex-auth', 'failed');
      driver.log(
        'error',
        brandBody(
          "Couldn't save your Codex credentials to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
        ),
      );
      if (driver.mode === 'terminal') {
        removeLoginRoot();
        process.exit(1);
      }
      driver.error(
        'codex_vault_failed',
        "Couldn't save your Codex credentials to the vault.",
        [{ kind: 'rerun', args: ['--protocol', 'nanoclaw.driver.v1'] }],
        'auth',
      );
    }

    setupLog.step('auth', 'success', durationMs, { PROVIDER: 'codex', METHOD: method });
    driver.progress('codex-auth', 'succeeded');
    driver.log(
      'success',
      brandBody('OpenAI account connected — credentials live in your OneCLI vault, never in the container.'),
    );
  } finally {
    driver.clearDisplay('codex-auth-url');
    driver.clearDisplay('codex-device-code');
    removeLoginRoot();
  }
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
    const child = spawn('codex', [prompt], { cwd: projectRoot, stdio: 'inherit' });
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
 * /add-codex skill checks. While codex ships in trunk these always pass; once
 * the payload moves to the providers branch, a failed check means the install
 * step should run (or the user finishes via /add-codex).
 */
export function verifyCodexInstall(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const root = process.cwd();

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

export async function runCodexInstallCheck(driver: SetupDriver): Promise<void> {
  if (driver.mode === 'terminal') p.log.step(brandBody('Checking the Codex provider install…'));
  else driver.progress('codex-install', 'running', 'Checking the Codex provider install');
  const { ok, problems } = verifyCodexInstall();
  if (ok) {
    setupLog.step('codex-install', 'success', 0, {});
    if (driver.mode === 'terminal') p.log.success(brandBody('Codex installed properly.'));
    else driver.progress('codex-install', 'succeeded');
    return;
  }

  setupLog.step('codex-install', 'failed', 0, { PROBLEMS: problems.join('; ') });
  if (driver.mode === 'ndjson') {
    driver.progress('codex-install', 'failed');
    driver.log(
      'warn',
      `The Codex provider is not fully installed: ${problems.join('; ')}. Run the /add-codex skill with your coding agent to finish it. Setup will continue; Codex groups will work once the install completes.`,
    );
    return;
  }

  p.log.warn(brandBody('The Codex provider is not fully installed:'));
  for (const problem of problems) console.log(k.dim(`   • ${problem}`));
  p.log.warn(
    brandBody(
      'Finish it with your coding agent of choice: open Codex CLI or Claude Code in this repo and run the /add-codex skill. Setup will continue — Codex groups will work once the install completes.',
    ),
  );
}

// Self-registration: the setup picker and the standalone `provider-auth` step
// render from the registry — this call is codex's only reach-in to the setup
// flow (guarded by the barrel-driven registration test).
registerSetupProvider({
  value: 'codex',
  label: 'Codex',
  hint: 'OpenAI — ChatGPT subscription or API key',
  supportsStructuredAuth: true,
  runAuth: runCodexAuthStep,
  runInstallCheck: runCodexInstallCheck,
  offerFailureAssist: offerCodexFailureAssist,
});
