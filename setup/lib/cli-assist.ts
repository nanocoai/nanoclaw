/**
 * Offer AI-coding CLI-assisted debugging when a setup step fails.
 *
 * Flow:
 *   1. Resolve the configured AI-coding CLI via `resolveAiCodingCli()`.
 *      Check it's installed; if not, offer to install it via the
 *      adapter's `installScript` (Claude Code only — Codex has no
 *      scriptable installer in this fork). Check auth via the
 *      adapter's `isAuthenticated()` probe; if not signed in (Claude
 *      only), offer to run `claude setup-token`. Other CLIs are
 *      expected to be authenticated by the operator outside setup.
 *      If either gate is declined or fails, silently skip.
 *   2. Ask the user for consent ("Want me to ask <CLI> for a fix?").
 *   3. Build a minimal prompt: the one-paragraph situation, the failing
 *      step's name/message/hint, and a short list of *file references*
 *      (not contents) so the CLI can Read what it needs on its own.
 *   4. Spawn the CLI in headless mode with tools enabled and a spinner
 *      that shows elapsed time.
 *   5. Parse `REASON:` / `COMMAND:` out of the response. Show the reason
 *      in a clack note, then hand off to `setup/run-suggested.sh` for
 *      editable pre-fill + exec.
 *
 * Skippable with NANOCLAW_SKIP_CLAUDE_ASSIST=1 for CI/scripted runs.
 * (The env var name is preserved for backward compatibility with
 * existing CI scripts.)
 */
import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { ensureAnswer } from './runner.js';
import { resolveAiCodingCli } from './ai-coding-cli/index.js';
import type { AiCodingCli } from './ai-coding-cli/types.js';
import { brandBody, fitToWidth, fmtDuration, note } from './theme.js';

export interface AssistContext {
  stepName: string;
  msg: string;
  hint?: string;
  /** Absolute path to the per-step raw log, if the caller has one. */
  rawLogPath?: string;
}

/**
 * File-path hints per step. The CLI reads these on its own via its Read
 * tool rather than us stuffing contents into the prompt. Keys are step
 * names as they appear in fail() calls; values are repo-relative paths.
 *
 * These are CLI-agnostic — same lists work for any AI-coding CLI.
 */
export const STEP_FILES: Record<string, string[]> = {
  bootstrap: ['setup.sh', 'setup/install-node.sh', 'nanoclaw.sh'],
  environment: ['setup/environment.ts'],
  container: [
    'setup/container.ts',
    'setup/install-docker.sh',
    'container/Dockerfile',
  ],
  onecli: ['setup/onecli.ts'],
  auth: [
    'setup/auth.ts',
    'setup/register-claude-token.sh',
    'setup/install-claude.sh',
  ],
  mounts: ['setup/mounts.ts'],
  service: ['setup/service.ts'],
  'cli-agent': ['setup/cli-agent.ts', 'scripts/init-cli-agent.ts'],
  timezone: ['setup/timezone.ts', 'setup/lib/tz-from-cli.ts'],
  channel: ['setup/auto.ts'],
  verify: ['setup/verify.ts'],
  // Channel-specific sub-steps:
  'telegram-install': ['setup/add-telegram.sh', 'setup/channels/telegram.ts'],
  'telegram-validate': ['setup/channels/telegram.ts'],
  'pair-telegram': ['setup/pair-telegram.ts', 'setup/channels/telegram.ts'],
  'discord-install': ['setup/add-discord.sh', 'setup/channels/discord.ts'],
  'slack-install': ['setup/add-slack.sh', 'setup/channels/slack.ts'],
  'slack-validate': ['setup/channels/slack.ts'],
  'imessage-install': ['setup/add-imessage.sh', 'setup/channels/imessage.ts'],
  'imessage': ['setup/channels/imessage.ts'],
  'teams-install': ['setup/add-teams.sh', 'setup/channels/teams.ts'],
  'teams-manifest': ['setup/lib/teams-manifest.ts', 'setup/channels/teams.ts'],
  'init-first-agent': [
    'scripts/init-first-agent.ts',
    'setup/channels/telegram.ts',
    'setup/channels/discord.ts',
  ],
};

export const BIG_PICTURE_FILES = ['README.md', 'setup/auto.ts'];

/**
 * Returns `true` if the user ran a CLI-suggested fix command; callers
 * can use that signal to offer a retry instead of aborting outright.
 * Returns `false` for every other outcome (skipped, declined, no command,
 * CLI unreachable, user chose not to run).
 */
export async function offerAiCodingCliAssist(
  ctx: AssistContext,
  projectRoot: string = process.cwd(),
): Promise<boolean> {
  if (process.env.NANOCLAW_SKIP_CLAUDE_ASSIST === '1') return false;
  if (!(await ensureAiCodingCliReady(projectRoot))) return false;

  const cli = resolveAiCodingCli();
  if (!cli) return false;

  const want = ensureAnswer(
    await p.confirm({
      message: `Want me to ask ${cli.displayName} to diagnose this?`,
      initialValue: true,
    }),
  );
  if (!want) return false;

  const prompt = buildPrompt(ctx, projectRoot);
  const response = await queryCliUnderSpinner(cli, prompt, projectRoot);
  if (!response) return false;

  const parsed = parseResponse(response);
  if (!parsed) {
    p.log.warn(brandBody(`${cli.displayName} responded but I couldn't parse a command out of it.`));
    p.log.message(k.dim(response.trim().slice(0, 500)));
    return false;
  }

  note(
    `${parsed.reason}\n\n${k.cyan('$')} ${parsed.command}`,
    `${cli.displayName}'s suggestion`,
  );

  const run = ensureAnswer(
    await p.confirm({
      message: 'Run this command? (you can edit it before executing)',
      initialValue: true,
    }),
  );
  if (!run) return false;

  await runSuggested(parsed.command, projectRoot);
  return true;
}

export function isAiCodingCliInstalled(): boolean {
  const cli = resolveAiCodingCli();
  return cli !== null && cli.isInstalled();
}

export function isAiCodingCliAuthenticated(): boolean {
  const cli = resolveAiCodingCli();
  if (!cli) return false;
  const probe = cli.isAuthenticated();
  // `undefined` means the adapter has no fast offline probe; treat that
  // as "good enough" — the CLI itself will surface auth errors when it
  // actually runs.
  return probe !== false;
}

export async function ensureAiCodingCliReady(projectRoot: string): Promise<boolean> {
  const cli = resolveAiCodingCli();
  if (!cli) {
    p.log.warn(brandBody("No AI-coding CLI is installed yet — can't diagnose this here."));
    return false;
  }

  if (!cli.isInstalled()) {
    if (!cli.installScript) {
      p.log.warn(
        brandBody(
          `${cli.displayName} isn't installed and has no scriptable installer. ` +
            `Install it manually and re-run setup.`,
        ),
      );
      return false;
    }

    const install = ensureAnswer(
      await p.confirm({
        message: `${cli.displayName} is needed to diagnose this. Install it now?`,
        initialValue: true,
      }),
    );
    if (!install) return false;

    const code = spawnSync('bash', [cli.installScript], {
      cwd: projectRoot,
      stdio: 'inherit',
    }).status;
    if (code !== 0 || !cli.isInstalled()) {
      p.log.error(`Couldn't install ${cli.displayName}.`);
      return false;
    }
    p.log.success(`${cli.displayName} installed.`);
  }

  // Auth gate: if the adapter exposes a probe and it returns false, try
  // to recover. The OAuth-token-capture flow is Claude-specific; for any
  // other CLI we just print guidance and bail.
  if (cli.isAuthenticated() === false) {
    if (cli.binary !== 'claude') {
      p.log.warn(
        brandBody(
          `${cli.displayName} isn't authenticated. Sign in via its own flow ` +
            `(\`${cli.binary} login\` or equivalent) and re-run setup.`,
        ),
      );
      return false;
    }
    if (!(await runClaudeSetupToken(projectRoot, cli))) return false;
  }

  return true;
}

/**
 * Claude-specific OAuth-token capture. Wraps `claude setup-token` in
 * script(1) so we can pull the bearer token out of the PTY output and
 * set CLAUDE_CODE_OAUTH_TOKEN for the rest of the setup process.
 */
async function runClaudeSetupToken(projectRoot: string, cli: AiCodingCli): Promise<boolean> {
  const auth = ensureAnswer(
    await p.confirm({
      message: `${cli.displayName} isn't signed in. Sign in now? (a browser will open)`,
      initialValue: true,
    }),
  );
  if (!auth) return false;

  // setup-token has an interactive TUI; reset terminal to cooked mode
  // so its prompts render correctly after clack's raw-mode prompts.
  spawnSync('stty', ['sane'], { stdio: 'inherit' });

  const tmpfile = path.join(os.tmpdir(), `claude-setup-token-${process.pid}`);
  try {
    const isUtilLinux = (() => {
      try {
        return execSync('script --version 2>&1', { encoding: 'utf-8' }).includes('util-linux');
      } catch { return false; }
    })();
    const scriptArgs = isUtilLinux
      ? ['-q', '-c', 'claude setup-token', tmpfile]
      : ['-q', tmpfile, 'claude', 'setup-token'];

    spawnSync('script', scriptArgs, {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    if (cli.isAuthenticated() === false && fs.existsSync(tmpfile)) {
      const raw = fs.readFileSync(tmpfile, 'utf-8');
      const stripped = raw
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/[\n\r]/g, '');
      const matches = stripped.match(/(sk-ant-oat[A-Za-z0-9_-]{80,500}AA)/g);
      if (matches) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = matches[matches.length - 1];
      }
    }
  } finally {
    try { fs.unlinkSync(tmpfile); } catch {}
  }

  if (cli.isAuthenticated() === false) {
    p.log.error(`Couldn't complete ${cli.displayName} sign-in.`);
    return false;
  }
  p.log.success(`${cli.displayName} signed in.`);
  return true;
}

function buildPrompt(ctx: AssistContext, projectRoot: string): string {
  const stepRefs = STEP_FILES[ctx.stepName] ?? [];
  const references = [
    ...BIG_PICTURE_FILES,
    ...stepRefs,
    'logs/setup.log',
    ctx.rawLogPath
      ? path.relative(projectRoot, ctx.rawLogPath)
      : 'logs/setup-steps/',
  ].filter((v, i, a) => a.indexOf(v) === i);

  const hintLine = ctx.hint ? `Hint shown to the user: ${ctx.hint}\n` : '';

  return [
    "I'm trying to set up NanoClaw on my machine and ran into an issue",
    'during the setup flow. Please read the referenced files to understand',
    'the flow and the step that failed, look at the logs to see what went',
    'wrong, then suggest a single bash command I can run to fix it.',
    '',
    `Failed step: ${ctx.stepName}`,
    `Error shown to the user: ${ctx.msg}`,
    hintLine,
    'References (read as needed with your Read tool):',
    ...references.map((r) => `  - ${r}`),
    '',
    'Respond in EXACTLY this format, nothing before or after:',
    '',
    'REASON: <one short line describing the root cause>',
    'COMMAND: <single bash command, one line, no backticks>',
    '',
    'If no safe single command can fix it, respond with:',
    'REASON: <why>',
    'COMMAND: none',
  ].join('\n');
}

/**
 * Run the configured AI-coding CLI in headless mode with tools enabled, while
 * showing a simple elapsed-time spinner. No streaming progress UI — the
 * earlier Claude-specific stream-json breadcrumb window was dropped to
 * keep the path uniform across CLIs (Phase C of plans/ai-coding-cli-pick.md).
 *
 * No hard timeout — debugging can take a long time, and the cost of
 * cutting the CLI off mid-investigation is worse than letting the
 * spinner run. The user can Ctrl-C if they want to abort.
 */
async function queryCliUnderSpinner(
  cli: AiCodingCli,
  prompt: string,
  projectRoot: string,
): Promise<string | null> {
  const spawnArgs = cli.headless(prompt, { tools: true });

  const s = p.spinner();
  const start = Date.now();
  const label = `Asking ${cli.displayName} to diagnose this…`;
  s.start(fitToWidth(label, ' (99m 59s)'));
  const tick = setInterval(() => {
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    s.message(`${fitToWidth(label, suffix)}${k.dim(suffix)}`);
  }, 1000);

  return new Promise<string | null>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (kind: 'ok' | 'error', payload: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(tick);
      const suffix = ` (${fmtDuration(Date.now() - start)})`;
      if (kind === 'ok') {
        s.stop(`${brandBody(fitToWidth(`${cli.displayName} replied.`, suffix))}${k.dim(suffix)}`);
        resolve(payload);
      } else {
        s.stop(
          `${fitToWidth(`${cli.displayName} couldn't help here.`, suffix)}${k.dim(suffix)}`,
          1,
        );
        const tail = stderr.trim().split('\n').slice(-3).join('\n');
        if (tail) p.log.message(k.dim(tail));
        resolve(null);
      }
    };

    const child = spawn(cli.binary, spawnArgs.args, {
      cwd: projectRoot,
      stdio: [spawnArgs.stdin, spawnArgs.output, spawnArgs.output],
    });

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf-8');
    });
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) finish('ok', stdout);
      else finish('error', null);
    });
    child.on('error', () => finish('error', null));
  });
}

function parseResponse(
  raw: string,
): { reason: string; command: string } | null {
  // Accept the fields anywhere in the output — the CLI sometimes wraps
  // the answer in a trailing explanation we can safely ignore.
  const reasonMatch = raw.match(/^\s*REASON:\s*(.+?)\s*$/m);
  const commandMatch = raw.match(/^\s*COMMAND:\s*(.+?)\s*$/m);
  if (!reasonMatch || !commandMatch) return null;
  const command = commandMatch[1].trim();
  if (!command || command.toLowerCase() === 'none') return null;
  return { reason: reasonMatch[1].trim(), command };
}

function runSuggested(command: string, projectRoot: string): Promise<void> {
  const script = path.join(projectRoot, 'setup/run-suggested.sh');
  if (!fs.existsSync(script)) {
    p.log.error(`Missing helper: ${script}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn('bash', [script, command], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
