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

import { brightSelect } from '../lib/bright-select.js';
import { type AssistContext, BIG_PICTURE_FILES, STEP_FILES } from '../lib/claude-assist.js';
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

function openAISecretExists(): boolean {
  try {
    return findOpenAISecret(listSecrets()) !== undefined;
  } catch {
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

export async function runCodexAuthStep(): Promise<void> {
  if (openAISecretExists()) {
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
          hint: 'pay-per-use; stored in OneCLI, never copied into the container',
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
    p.log.warn(brandBody('Codex sign-in skipped. Add an OpenAI account to OneCLI before using Codex groups.'));
    return;
  }

  if (method === 'api') {
    await runCodexApiKeyAuth();
    return;
  }

  await runCodexLoginAuth(method);
}

async function runCodexApiKeyAuth(): Promise<void> {
  const key = ensureAnswer(
    await p.password({
      message: 'Paste your OpenAI API key (sk-…)',
      validate: (v) => (v && v.trim().startsWith('sk-') ? undefined : 'That does not look like an OpenAI API key.'),
    }),
  ) as string;

  try {
    execFileSync(
      'onecli',
      [
        'secrets',
        'create',
        '--name',
        'Codex',
        '--type',
        'openai',
        '--value',
        key.trim(),
        '--host-pattern',
        'api.openai.com',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'codex', METHOD: 'api', ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your OpenAI key to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }
  setupLog.step('auth', 'success', 0, { PROVIDER: 'codex', METHOD: 'api' });
  p.log.success(brandBody('OpenAI account connected.'));
}

export async function runCodexLoginAuth(method: 'browser' | 'device'): Promise<void> {
  const codexCheck = spawnSync('codex', ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (codexCheck.status !== 0) {
    p.log.error(
      brandBody(
        'The Codex CLI is not installed on this machine. Install it with `npm install -g @openai/codex`, then re-run setup — or choose the API key option instead.',
      ),
    );
    setupLog.step('auth', 'failed', 0, { PROVIDER: 'codex', METHOD: method, ERROR: 'codex_cli_missing' });
    process.exit(1);
  }

  if (method === 'browser') {
    p.log.step(brandBody('Opening the Codex sign-in flow…'));
    console.log(k.dim('   (a browser will open for sign-in; this part is interactive)'));
  } else {
    p.log.step(brandBody('Starting Codex device-code pairing…'));
    console.log(k.dim('   (a URL and code will appear below — open the URL and enter the code)'));
  }
  console.log();

  // Session-isolation invariant (see file header): the login runs under a
  // throwaway CODEX_HOME so the vaulted session is dedicated to the gateway
  // and never shared with the user's personal ~/.codex.
  const loginHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-vault-login-'));
  // Holds a live credential after login — must go on every exit path. The
  // failure branches call process.exit, which skips finally blocks, so each
  // removes it explicitly.
  const removeLoginHome = (): void => fs.rmSync(loginHome, { recursive: true, force: true });

  const args = method === 'device' ? ['login', '--device-auth'] : ['login'];
  const start = Date.now();
  const code = await runInherit('codex', args, { CODEX_HOME: loginHome });
  const durationMs = Date.now() - start;
  console.log();

  if (code !== 0) {
    removeLoginHome();
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, EXIT_CODE: String(code) });
    p.log.error(
      brandBody(
        "Couldn't complete the Codex sign-in. Re-run setup and try again, or choose the API key option instead.",
      ),
    );
    process.exit(1);
  }

  const authJsonPath = path.join(loginHome, 'auth.json');
  if (!fs.existsSync(authJsonPath)) {
    removeLoginHome();
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: 'auth_json_not_found' });
    p.log.error(
      brandBody('Codex login succeeded but no auth.json was written. Try again, or paste an API key instead.'),
    );
    process.exit(1);
  }

  try {
    execFileSync(
      'onecli',
      [
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
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    removeLoginHome();
    setupLog.step('auth', 'failed', durationMs, { PROVIDER: 'codex', METHOD: method, ERROR: String(err) });
    p.log.error(
      brandBody(
        "Couldn't save your Codex credentials to the vault. Make sure OneCLI is running (`onecli version`), then retry.",
      ),
    );
    process.exit(1);
  }
  removeLoginHome();
  setupLog.step('auth', 'success', durationMs, { PROVIDER: 'codex', METHOD: method });
  p.log.success(brandBody('OpenAI account connected — credentials live in your OneCLI vault, never in the container.'));
}

function runInherit(cmd: string, args: string[], extraEnv?: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
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

export async function runCodexInstallCheck(): Promise<void> {
  p.log.step(brandBody('Checking the Codex provider install…'));
  const { ok, problems } = verifyCodexInstall();
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
  runAuth: runCodexAuthStep,
  runInstallCheck: runCodexInstallCheck,
  offerFailureAssist: offerCodexFailureAssist,
});
