/**
 * User-initiated handoff to interactive Claude, parallel to claude-assist.ts.
 *
 * claude-assist is for failures: it runs `claude -p` non-interactively, parses
 * a suggested command, and offers to run it. This module is for the opposite
 * case — the user is mid-flow, not stuck on an error, and wants Claude to
 * walk them through something the driver can't fully automate (Azure portal
 * clickthrough, writing a manifest, tunneling a port, etc.).
 *
 * Flow:
 *   1. Build a handoff prompt from the caller's context: channel, current
 *      step, completed steps, collected values (secrets redacted), relevant
 *      files to read.
 *   2. Spawn `claude "<prompt>" --permission-mode auto` with
 *      `stdio: 'inherit'` so Claude owns the terminal. The positional prompt
 *      is auto-submitted as the first user message, so Claude starts
 *      orienting immediately instead of sitting at an empty prompt — and the
 *      context stays visible in the transcript and survives `--resume`,
 *      which an --append-system-prompt would not.
 *   2a. All handoffs in one setup run share a single session: the first
 *      spawn pins a generated UUID via `--session-id`, later spawns pass
 *      `--resume <uuid>` so Claude keeps the context of earlier handoffs.
 *      (stdio is inherited, so we can't *read* the session id Claude picks —
 *      pinning our own is the only way to find the session again.)
 *   3. When Claude exits (user types /exit, Ctrl-D, or closes the session),
 *      control returns to the setup driver. The driver can then re-offer the
 *      same step (e.g., "How did that go?" select).
 *
 * Also exports a small helper for text/password prompts: `validateWithHelpEscape`
 * wraps a validate callback so typing `?` triggers the handoff instead of
 * attempting to parse it as a real answer.
 */
import { execSync, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import {
  type AssistContext,
  BIG_PICTURE_FILES,
  ensureClaudeReady,
  offerClaudeAssist,
  STEP_FILES,
} from './claude-assist.js';
import { ensureAnswer } from './runner.js';
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
   * secrets before passing (e.g., show last 4 chars). Used to give Claude
   * the state of the operator's progress.
   */
  collectedValues?: Record<string, string>;
  /**
   * Repo-relative paths Claude should consider reading. Always gets
   * logs/setup.log and the relevant SKILL.md appended by the builder.
   */
  files?: string[];
}

/**
 * Spawn interactive Claude with the handoff context as an auto-submitted
 * first prompt. Returns when Claude exits.
 *
 * Silently no-ops (returns `false`) if `claude` isn't on PATH — setup runs
 * where the binary is guaranteed to exist (we install it in the auth step),
 * but an ultra-early flow failure could technically reach this before that
 * install, and crashing the handoff would be worse than the handoff not
 * firing.
 */
export async function offerClaudeHandoff(ctx: HandoffContext): Promise<boolean> {
  if (!isClaudeUsable()) {
    p.log.warn(
      brandBody("Claude isn't installed yet — can't hand you off here. Finish setup first, then retry."),
    );
    return false;
  }

  note(
    [
      "I'm handing you off to Claude in interactive mode.",
      "It has the context of where you are in setup.",
      "",
      k.dim("Type /exit (or press Ctrl-D) when you're ready to come back to setup."),
    ].join('\n'),
    'Handing off to Claude',
  );

  return spawnInteractiveClaude(buildHandoffPrompt(ctx));
}

// One session shared by every interactive handoff in this setup-driver
// process. We pin the id ourselves (--session-id) on the first spawn because
// stdio is inherited and Claude's own id is never visible to us; subsequent
// spawns --resume it so Claude remembers earlier handoffs. Separate from
// claude-assist's non-interactive session — the two formats don't mix.
const handoffSessionId = randomUUID();
let handoffSessionStarted = false;

/**
 * Spawn interactive Claude with the handoff context auto-submitted as the
 * first user message. Resolves when Claude exits and control returns to
 * the setup driver.
 */
function spawnInteractiveClaude(prompt: string): Promise<boolean> {
  const sessionArgs = handoffSessionStarted
    ? ['--resume', handoffSessionId]
    : ['--session-id', handoffSessionId];
  return new Promise<boolean>((resolve) => {
    const child = spawn(
      'claude',
      [
        prompt,
        '--permission-mode',
        'auto',
        ...sessionArgs,
      ],
      { stdio: 'inherit' },
    );
    child.on('close', () => {
      handoffSessionStarted = true;
      p.log.success(brandBody("Back from Claude. Let's continue."));
      resolve(true);
    });
    child.on('error', () => {
      p.log.error("Couldn't launch Claude. Continuing without handoff.");
      resolve(false);
    });
  });
}

/**
 * Sentinel returned by `validateWithHelpEscape` when the user types `?`.
 * The caller compares against this to decide whether to trigger a handoff.
 */
export const HELP_ESCAPE_SENTINEL = '__NANOCLAW_HELP_ESCAPE__';

/**
 * Wrap a clack `validate` callback so typing `?` short-circuits validation
 * and returns the HELP_ESCAPE_SENTINEL. Caller should check for the sentinel
 * after awaiting the prompt and trigger offerClaudeHandoff if matched.
 *
 * Usage:
 *   const answer = await p.text({
 *     message: 'Paste your Azure App ID',
 *     validate: validateWithHelpEscape((v) => {
 *       if (!/^[0-9a-f-]{36}$/.test(v)) return 'Expected a UUID';
 *       return undefined;
 *     }),
 *   });
 *   if (answer === HELP_ESCAPE_SENTINEL) { await offerClaudeHandoff(ctx); ... }
 */
export function validateWithHelpEscape(
  inner?: (value: string) => string | Error | undefined,
): (value: string) => string | Error | undefined {
  return (value: string) => {
    if ((value ?? '').trim() === '?') {
      // Returning undefined lets clack accept the `?` as the "answer". The
      // caller sees a literal "?" and should compare + escape to handoff.
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

function isClaudeUsable(): boolean {
  try {
    execSync('command -v claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function buildHandoffPrompt(ctx: HandoffContext): string {
  const lines: string[] = [
    `I'm running NanoClaw's interactive \`setup:auto\` flow to wire the ${ctx.channel} channel`,
    `and got stuck at the step: "${ctx.step}" (${ctx.stepDescription}).`,
    '',
    'Help me complete this specific step and get back to setup.',
    'You can read files, run commands, search the web,',
    "and explain concepts. Be concise. When I'm ready to resume, remind me to type",
    "/exit and I'll return to the setup flow at the same step.",
    '',
  ];

  if (ctx.completedSteps && ctx.completedSteps.length > 0) {
    lines.push("Steps I've already completed:");
    for (const s of ctx.completedSteps) lines.push(`  ✓ ${s}`);
    lines.push('');
  }

  if (ctx.collectedValues && Object.keys(ctx.collectedValues).length > 0) {
    lines.push('Values collected so far (secrets redacted):');
    for (const [k, v] of Object.entries(ctx.collectedValues)) {
      lines.push(`  ${k}: ${v}`);
    }
    lines.push('');
  }

  const files = [
    ...(ctx.files ?? []),
    'logs/setup.log',
    'logs/setup-steps/',
    // The bespoke `setup/channels/<channel>.ts` flows are deleted — point the
    // agent at the channel's SKILL.md, which now owns the whole procedure.
    `.claude/skills/add-${ctx.channel}/SKILL.md`,
  ].filter((v, i, a) => a.indexOf(v) === i);

  lines.push('Relevant files (read as needed with the Read tool):');
  for (const f of files) lines.push(`  - ${f}`);

  return lines.join('\n');
}

/**
 * Dispatcher: checks NANOCLAW_SETUP_ASSIST_MODE and delegates to either
 * the interactive failure handoff (default) or the non-interactive assist.
 *
 * Drop-in replacement for `offerClaudeAssist` at failure call sites.
 */
export async function offerClaudeOnFailure(
  ctx: AssistContext,
  projectRoot: string = process.cwd(),
): Promise<boolean> {
  if (process.env.NANOCLAW_SETUP_ASSIST_MODE === 'true' || process.env.NANOCLAW_SETUP_ASSIST_MODE === '1') {
    return offerClaudeAssist(ctx, projectRoot);
  }
  return offerFailureHandoff(ctx, projectRoot);
}

/**
 * Interactive Claude handoff for setup failures. Same role as
 * `offerClaudeAssist` but spawns an interactive session instead of
 * parsing a structured REASON/COMMAND response.
 *
 * Returns `true` if Claude was launched (the user may have fixed
 * things during the session), `false` if skipped/declined/unavailable.
 */
async function offerFailureHandoff(
  ctx: AssistContext,
  projectRoot: string,
): Promise<boolean> {
  if (process.env.NANOCLAW_SKIP_CLAUDE_ASSIST === '1') return false;
  if (!(await ensureClaudeReady(projectRoot))) return false;

  const want = ensureAnswer(
    await p.confirm({
      message: 'Want to debug this with Claude?',
      initialValue: true,
    }),
  );
  if (!want) return false;

  note(
    [
      "Launching Claude to help debug this failure.",
      "It has the context of what went wrong.",
      "",
      k.dim("Type /exit (or press Ctrl-D) when you're ready to come back to setup."),
    ].join('\n'),
    'Handing off to Claude',
  );

  return spawnInteractiveClaude(buildFailurePrompt(ctx, projectRoot));
}

function buildFailurePrompt(ctx: AssistContext, projectRoot: string): string {
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
    "I'm running NanoClaw's interactive setup flow and hit a failure.",
    '',
    `Failed step: ${ctx.stepName}`,
    `Error: ${ctx.msg}`,
  ];

  if (ctx.hint) lines.push(`Hint shown to me: ${ctx.hint}`);

  lines.push(
    '',
    'Help me diagnose and fix this issue. Read the referenced files and logs',
    'to understand what went wrong, then help me fix it. You can read files,',
    'run commands, check logs, and explain what happened. Be concise.',
    "When I'm ready to resume setup, remind me to type /exit.",
    '',
    'Relevant files (read as needed with the Read tool):',
  );
  for (const f of references) lines.push(`  - ${f}`);

  return lines.join('\n');
}
