/**
 * User-initiated handoff to an interactive AI-coding CLI, parallel to cli-assist.ts.
 *
 * cli-assist is for failures: it runs the CLI in headless print mode,
 * parses a suggested command, and offers to run it. This module is for
 * the opposite case — the user is mid-flow, not stuck on an error, and
 * wants the CLI to walk them through something the driver can't fully
 * automate (Azure portal clickthrough, writing a manifest, tunneling a
 * port, etc.).
 *
 * Flow:
 *   1. Build a handoff prompt from the caller's context: channel, current
 *      step, completed steps, collected values (secrets redacted), relevant
 *      files to read.
 *   2. Resolve the configured AI-coding CLI (Claude Code, OpenAI Codex, …) via
 *      `resolveAiCodingCli()` and spawn it interactively with the prompt as
 *      the opening message; stdio is inherited so the CLI owns the terminal.
 *   3. When the CLI exits, control returns to the setup driver. The driver
 *      can then re-offer the same step (e.g., "How did that go?" select).
 *
 * Also exports a small helper for text/password prompts: `validateWithHelpEscape`
 * wraps a validate callback so typing `?` triggers the handoff instead of
 * attempting to parse it as a real answer.
 */
import { spawn } from 'child_process';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import {
  type AssistContext,
  BIG_PICTURE_FILES,
  ensureAiCodingCliReady,
  offerAiCodingCliAssist,
  STEP_FILES,
} from './cli-assist.js';
import { ensureAnswer } from './runner.js';
import { resolveAiCodingCli } from './ai-coding-cli/index.js';
import type { AiCodingCli } from './ai-coding-cli/types.js';
import { brandBody, note } from './theme.js';

export interface HandoffContext {
  /** Channel this handoff is happening in (e.g., 'teams'). */
  channel: string;
  /** Short name of the current step the user is stuck on. */
  step: string;
  /** Human-readable summary of what the user was trying to do at this step. */
  stepDescription: string;
  /** Checklist of sub-steps already completed (displayed as `✓ <item>`). */
  completedSteps?: string[];
  /**
   * Key/value pairs of values collected so far. Callers should redact
   * secrets before passing (e.g., show last 4 chars). Used to give the
   * CLI the state of the operator's progress.
   */
  collectedValues?: Record<string, string>;
  /**
   * Repo-relative paths the CLI should consider reading. Always gets
   * logs/setup.log and the relevant SKILL.md appended by the builder.
   */
  files?: string[];
}

/**
 * Spawn the configured AI-coding CLI in interactive mode with the rendered
 * context as its opening prompt. Returns when the CLI exits.
 *
 * Silently no-ops (returns `false`) if no AI-coding CLI is available — setup
 * runs where one is guaranteed to exist (we install it in the auth step
 * or via the picker), but an ultra-early flow failure could technically
 * reach this before that install, and crashing the handoff would be
 * worse than the handoff not firing.
 */
export async function offerAiCodingCliHandoff(ctx: HandoffContext): Promise<boolean> {
  const cli = resolveAiCodingCli();
  if (!cli) {
    p.log.warn(
      brandBody("No AI-coding CLI is installed yet — can't hand you off here. Finish setup first, then retry."),
    );
    return false;
  }

  const prompt = buildSystemPrompt(ctx);

  note(
    [
      `I'm handing you off to ${cli.displayName} in interactive mode.`,
      'It has the context of where you are in setup.',
      '',
      k.dim("Type /exit (or press Ctrl-D) when you're ready to come back to setup."),
    ].join('\n'),
    `Handing off to ${cli.displayName}`,
  );

  return runHandoff(cli, prompt);
}

/**
 * Sentinel returned by `validateWithHelpEscape` when the user types `?`.
 * The caller compares against this to decide whether to trigger a handoff.
 */
export const HELP_ESCAPE_SENTINEL = '__NANOCLAW_HELP_ESCAPE__';

/**
 * Wrap a clack `validate` callback so typing `?` short-circuits validation
 * and returns the HELP_ESCAPE_SENTINEL. Caller should check for the sentinel
 * after awaiting the prompt and trigger offerAiCodingCliHandoff if matched.
 *
 * Usage:
 *   const answer = await p.text({
 *     message: 'Paste your Azure App ID',
 *     validate: validateWithHelpEscape((v) => {
 *       if (!/^[0-9a-f-]{36}$/.test(v)) return 'Expected a UUID';
 *       return undefined;
 *     }),
 *   });
 *   if (answer === HELP_ESCAPE_SENTINEL) { await offerAiCodingCliHandoff(ctx); ... }
 */
export function validateWithHelpEscape(
  inner?: (value: string) => string | Error | undefined,
): (value: string) => string | Error | undefined {
  return (value: string) => {
    if ((value ?? '').trim() === '?') {
      return undefined;
    }
    return inner ? inner(value) : undefined;
  };
}

/**
 * True if the value returned by a text/password prompt should trigger a
 * handoff. Abstracts the sentinel check so callers don't have to import it
 * directly at every site.
 */
export function isHelpEscape(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '?';
}

export function isAiCodingCliUsable(): boolean {
  return resolveAiCodingCli() !== null;
}

function buildSystemPrompt(ctx: HandoffContext): string {
  const lines: string[] = [
    `The user is running NanoClaw's interactive \`setup:auto\` flow to wire the ${ctx.channel} channel.`,
    `They got stuck at the step: "${ctx.step}" (${ctx.stepDescription}) and asked for help.`,
    '',
    "Your job: help them complete this specific step and get back to setup.",
    "You can read files, run commands, search the web, and explain concepts.",
    "Be concise. When they're ready to resume, tell them to type /exit and",
    "they'll return to the setup flow at the same step.",
    '',
  ];

  if (ctx.completedSteps && ctx.completedSteps.length > 0) {
    lines.push('Steps they have already completed:');
    for (const s of ctx.completedSteps) lines.push(`  ✓ ${s}`);
    lines.push('');
  }

  if (ctx.collectedValues && Object.keys(ctx.collectedValues).length > 0) {
    lines.push('Values collected so far (secrets redacted):');
    for (const [key, v] of Object.entries(ctx.collectedValues)) {
      lines.push(`  ${key}: ${v}`);
    }
    lines.push('');
  }

  const files = [
    ...(ctx.files ?? []),
    'logs/setup.log',
    'logs/setup-steps/',
    `.claude/skills/add-${ctx.channel}/SKILL.md`,
    `setup/channels/${ctx.channel}.ts`,
  ].filter((v, i, a) => a.indexOf(v) === i);

  lines.push('Relevant files (read as needed with the Read tool):');
  for (const f of files) lines.push(`  - ${f}`);

  return lines.join('\n');
}

/**
 * Dispatcher: checks NANOCLAW_SETUP_ASSIST_MODE and delegates to either
 * the interactive failure handoff (default) or the non-interactive assist.
 *
 * Drop-in replacement for `offerAiCodingCliAssist` at failure call sites.
 */
export async function offerAiCodingCliOnFailure(
  ctx: AssistContext,
  projectRoot: string = process.cwd(),
): Promise<boolean> {
  if (process.env.NANOCLAW_SETUP_ASSIST_MODE === 'true' || process.env.NANOCLAW_SETUP_ASSIST_MODE === '1') {
    return offerAiCodingCliAssist(ctx, projectRoot);
  }
  return offerFailureHandoff(ctx, projectRoot);
}

/**
 * Interactive AI-coding CLI handoff for setup failures. Same role as
 * `offerAiCodingCliAssist` but spawns an interactive session instead of
 * parsing a structured REASON/COMMAND response.
 *
 * Returns `true` if the CLI was launched (the user may have fixed
 * things during the session), `false` if skipped/declined/unavailable.
 */
async function offerFailureHandoff(
  ctx: AssistContext,
  projectRoot: string,
): Promise<boolean> {
  if (process.env.NANOCLAW_SKIP_CLAUDE_ASSIST === '1') return false;
  if (!(await ensureAiCodingCliReady(projectRoot))) return false;

  const cli = resolveAiCodingCli();
  if (!cli) return false;

  const want = ensureAnswer(
    await p.confirm({
      message: `Want to debug this with ${cli.displayName}?`,
      initialValue: true,
    }),
  );
  if (!want) return false;

  const prompt = buildFailureSystemPrompt(ctx, projectRoot);

  note(
    [
      `Launching ${cli.displayName} to help debug this failure.`,
      'It has the context of what went wrong.',
      '',
      k.dim("Type /exit (or press Ctrl-D) when you're ready to come back to setup."),
    ].join('\n'),
    `Handing off to ${cli.displayName}`,
  );

  return runHandoff(cli, prompt);
}

function runHandoff(cli: AiCodingCli, prompt: string): Promise<boolean> {
  const spawnArgs = cli.handoff(prompt);
  return new Promise<boolean>((resolve) => {
    const child = spawn(cli.binary, spawnArgs.args, {
      stdio: [spawnArgs.stdin, spawnArgs.output, spawnArgs.output],
    });
    child.on('close', () => {
      p.log.success(brandBody(`Back from ${cli.displayName}. Let's continue.`));
      resolve(true);
    });
    child.on('error', () => {
      p.log.error(`Couldn't launch ${cli.displayName}. Continuing without handoff.`);
      resolve(false);
    });
  });
}

function buildFailureSystemPrompt(ctx: AssistContext, projectRoot: string): string {
  const stepRefs = STEP_FILES[ctx.stepName] ?? [];
  const references = [
    ...BIG_PICTURE_FILES,
    ...stepRefs,
    'logs/setup.log',
    ctx.rawLogPath
      ? path.relative(projectRoot, ctx.rawLogPath)
      : 'logs/setup-steps/',
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
    "When they're ready to resume setup, tell them to type /exit.",
    '',
    'Relevant files (read as needed with the Read tool):',
  );
  for (const f of references) lines.push(`  - ${f}`);

  return lines.join('\n');
}
