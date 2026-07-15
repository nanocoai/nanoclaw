/**
 * The thin generic driver: render a SKILL.md's human I/O through clack and run
 * the directive engine. The entire connect+wire procedure now lives in the
 * SKILL.md — operator walkthroughs (`nc:operator`), credential prompts
 * (`nc:prompt`), the service restart (`nc:run effect:restart`), and the wiring
 * (`nc:run effect:wire`, `ncl …`). So the driver is just: ask the prompts
 * (`resolveInput`), render the engine's events (`onEvent` — spinners for step
 * events, notes + policy for operator blocks), run the engine in document order.
 *
 * The engine only DECLARES and EMITS (scripts/skill-apply.ts); everything
 * presentational lives here, derived from document structure via the shared
 * policy module (scripts/skill-policy.ts): the natural-barrier gate confirm,
 * the URL offer, the prose-derived validation message.
 */
import { execSync, spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import * as p from '@clack/prompts';

import {
  applySkill,
  fullyApplied,
  normalizeValue,
  stepLabel,
  type ApplyEvent,
  type ApplyResult,
  type InputMeta,
  type StepOutcome,
} from '../../scripts/skill-apply.js';
import { parseDirectives, promptVar } from '../../scripts/skill-directives.js';
import { extractOfferUrl, gatePolicy } from '../../scripts/skill-policy.js';
import * as setupLog from '../logs.js';
import { isHeadless } from '../platform.js';
import { openUrl } from './browser.js';
import { isHelpEscape, offerClaudeHandoff, validateWithHelpEscape } from './claude-handoff.js';
import { startSpinner } from './runner.js';

/**
 * Build the clack `validate` callback an `nc:prompt` carries — the interactive
 * enforcement of `validate:<re>` (with `flags:`). On a miss the message is
 * derived from the QUESTION PROSE, which by authoring convention describes the
 * expected shape ("Paste the bot token (looks like `123456:ABC-DEF...`)."), so
 * there is no separate authored error string. Returns undefined when the prompt
 * declares no regex. Exported so the policy is unit-testable without a TTY.
 * Normalization is NOT here: it's deterministic, applied at bind by the engine
 * (skill-apply `normalizeValue`), so it lands the same for `inputs` and typed
 * answers.
 */
export function promptValidator(
  validate: string | undefined,
  flags: string | undefined,
  question: string,
): ((v: string | undefined) => string | undefined) | undefined {
  if (!validate) return undefined;
  const re = new RegExp(validate, flags);
  return (v) => (re.test((v ?? '').trim()) ? undefined : `That doesn't match the expected format. ${question}`);
}

/**
 * The literal alternatives of a fully-anchored pure-literal alternation —
 * `^(socket|webhook)$` → ['socket', 'webhook'] — or null for anything else
 * (an unanchored prefix like `^xoxb-`, a format union with real regex syntax
 * like imessage's `^(\+\d{8,15}|…)$`). This is what lets an either/or
 * `nc:prompt` render as an arrow-key select with no grammar addition: the
 * validate regex already enumerates the choices. Exported for tests.
 */
export function literalChoices(validate: string | undefined): string[] | null {
  const m = validate?.match(/^\^\(([A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)+)\)\$$/);
  return m ? m[1].split('|') : null;
}

/**
 * Handoff context for the `?` help-escape (Step 8 / mechanism M3). A lone `?` at
 * any prompt hands the operator to interactive Claude with this context, then
 * re-asks the same prompt. Both fields are optional so a bare
 * `clackResolveInput()` (e.g. the standalone CLI below) still works — it just
 * hands off with a generic `setup` channel and the prompt's own var name as the
 * step.
 */
export interface PrompterContext {
  /** Channel this run is wiring (e.g. 'telegram') — surfaced to the handoff. */
  channel?: string;
  /** Short label for the current setup step — surfaced to the handoff. */
  step?: string;
}

/**
 * The wizard's `resolveInput` implementation: collect an `nc:prompt` through
 * clack (password for secrets, an arrow-key select for an either/or validate
 * regex, text otherwise; a cancel defers), running the interactive re-ask loop
 * against the prompt's declared `validate:`/`flags:` (the engine's
 * validate-at-bind is the programmatic backstop, not the UX).
 */
export function clackResolveInput(ctx: PrompterContext = {}): (name: string, meta: InputMeta) => Promise<string | undefined> {
  // The `?` help-escape is only meaningful at a real terminal: it hands the
  // operator off to an interactive Claude session (stdio inherited). In a
  // headless / non-TTY run nobody can type `?` into a clack prompt anyway, and
  // we must never spawn an interactive child without a TTY — so it's a no-op
  // there (read at ask-time so a re-run picks up a terminal that appears later).
  async function ask(name: string, meta: InputMeta): Promise<string | undefined> {
    const check = promptValidator(meta.validate, meta.flags, meta.question);
    // Wrap the validator so a lone `?` short-circuits format checks and comes
    // back as a literal "?" instead of being rejected — we intercept it below.
    const guarded = validateWithHelpEscape(check);
    // clearOnError wipes a rejected secret so the operator re-pastes cleanly
    // (a half-pasted token isn't left masked in the field).
    // An either/or prompt renders as an arrow-key select — the options come
    // straight from the validate regex (literalChoices). No re-ask loop and no
    // `?` help-escape there: every choice is valid and self-describing.
    const choices = meta.secret ? null : literalChoices(meta.validate);
    const ans = choices
      ? await p.select({ message: meta.question, options: choices.map((c) => ({ value: c, label: c })) })
      : meta.secret
        ? await p.password({ message: meta.question, validate: guarded, clearOnError: true })
        : await p.text({ message: meta.question, validate: guarded });
    if (p.isCancel(ans)) return undefined; // cancelled ⇒ defer
    if (isHelpEscape(ans) && process.stdout.isTTY) {
      // Operator asked for help: hand off to interactive Claude with this
      // prompt's context, then re-ask the same prompt. Recursion is operator-
      // bounded — they decide when to stop typing `?`.
      await offerClaudeHandoff({
        channel: ctx.channel ?? 'setup',
        step: ctx.step ?? name,
        stepDescription: meta.question,
      });
      return ask(name, meta);
    }
    const v = String(ans).trim();
    return v.length ? v : undefined;
  }
  return ask;
}

/**
 * The default `confirm` seam: a clack yes/no, TTY-gated exactly like the step
 * spinner — a non-TTY run resolves TRUE (proceed), so a headless run with full
 * inputs never stalls on a barrier or an offer. A cancel counts as decline.
 */
async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdout.isTTY) return true;
  const ans = await p.confirm({ message });
  return ans === true; // cancel ⇒ false
}

/**
 * The default `openUrl` seam: best-effort browser open (setup/lib/browser.ts).
 * Headless-safe: on a machine with no display we skip the open entirely — the
 * URL is already in the rendered operator note for copy-paste.
 */
async function defaultOpenUrl(url: string): Promise<void> {
  if (isHeadless()) return;
  openUrl(url);
}

/** Mask a credential for display: first 6 + last 4. */
function maskValue(v: string): string {
  return v.length <= 12 ? '••••' : `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** Parse `KEY=value` lines from a .env file body. */
function parseEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Offer to reuse credentials already in `.env` so a re-run doesn't re-prompt for
 * them. The prompt var → ENV_KEY mapping comes from the skill's own `env-set`
 * directives, so this stays generic. Returns the inputs the operator chose to
 * reuse (interactive: each is confirmed via the `confirm` seam).
 *
 * Every offer is PRE-FILTERED through the target prompt's declared
 * `normalize`/`validate`/`flags`: an `.env` value that would fail the engine's
 * validate-at-bind is silently not offered, so the operator is prompted fresh
 * instead of hitting a dead-end (`inputs` win outright at bind — a stale
 * credential passed through would reject loudly with no re-ask).
 */
async function reuseFromEnv(
  skillDir: string,
  projectRoot: string,
  alreadyHave: Record<string, string>,
  confirm: (message: string) => Promise<boolean>,
): Promise<Record<string, string>> {
  let md: string;
  try {
    md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    return {};
  }
  const varToKey = new Map<string, string>();
  const promptShape = new Map<string, { validate?: string; flags?: string; normalize?: string }>();
  for (const d of parseDirectives(md)) {
    // 1st pass: infer var → ENV_KEY from env-set directives (KEY={{var}}).
    if (d.kind === 'env-set') {
      for (const line of d.body) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/);
        if (m) varToKey.set(m[2], m[1]); // var → ENV_KEY
      }
    }
    if (d.kind === 'prompt') {
      const v = promptVar(d);
      if (!v) continue;
      // Record each prompt's declared value shape for the reuse pre-filter.
      promptShape.set(v, {
        validate: typeof d.attrs.validate === 'string' ? d.attrs.validate : undefined,
        flags: typeof d.attrs.flags === 'string' ? d.attrs.flags : undefined,
        normalize: typeof d.attrs.normalize === 'string' ? d.attrs.normalize : undefined,
      });
      // 2nd pass: an explicit `nc:prompt … reuse:<ENV_KEY>` links a prompt to a
      // credential a HELPER SCRIPT owns — written by effect:external, not
      // nc:env-set (e.g. imessage's Photon IMESSAGE_SERVER_URL /
      // IMESSAGE_API_KEY). The env-set inference above can't see those, so the
      // prompt states the linkage to regain the masked reuse offer on a re-run.
      if (typeof d.attrs.reuse === 'string') varToKey.set(v, d.attrs.reuse);
    }
  }
  let env: Record<string, string> = {};
  try {
    env = parseEnv(readFileSync(join(projectRoot, '.env'), 'utf8'));
  } catch {
    return {};
  }
  const reuse: Record<string, string> = {};
  for (const [v, key] of varToKey) {
    if (v in alreadyHave) continue; // caller already supplied it
    const existing = env[key];
    if (!existing) continue;
    // Pre-filter: normalize-then-validate, mirroring the engine's bind order. A
    // stale credential that no longer matches the declared shape is never
    // offered — prompting fresh beats a loud validate-at-bind dead-end.
    const shape = promptShape.get(v);
    if (shape?.validate && !new RegExp(shape.validate, shape.flags).test(normalizeValue(existing, shape.normalize))) continue;
    if (await confirm(`Found an existing ${key} (${maskValue(existing)}). Use it?`)) reuse[v] = existing;
  }
  return reuse;
}

/**
 * Host exec for the engine's run directives. Returns stdout so a
 * `run capture:<var>` can bind it. Puts the project's `bin/` on PATH so a bare
 * `ncl …` in a wire directive resolves to `bin/ncl` even when it isn't
 * symlinked onto the operator's PATH.
 *
 * Async (spawn, not execSync) so the step spinner keeps animating: a sync exec
 * blocks the event loop for the whole command and freezes every ticker in the
 * process. A failure rejects with the FIRST line as the actionable summary —
 * `exit <code>: <first stderr line>` — and the full stderr kept below, so
 * one-line consumers (run-channel-skill's bounce warn) stay readable while the
 * agentTask reason an agent fixes from still carries everything.
 *
 * Non-step effects are captured-output steps — the spinner is the only UI, and
 * stderr is piped, never echoed (a chatty tool's warnings don't belong on the
 * wizard screen). When `rawLog` is given, every command's stdout+stderr is
 * appended there (level 3, like runner.ts's per-step raw logs) so the silenced
 * noise stays inspectable.
 */
export function hostExec(projectRoot: string, rawLog?: string): (cmd: string) => Promise<string> {
  const tee = (cmd: string, stdout: string, stderr: string): void => {
    if (!rawLog) return;
    const body = [stdout, stderr].filter(Boolean).join('');
    appendFileSync(rawLog, `$ ${cmd}\n${body}${body && !body.endsWith('\n') ? '\n' : ''}\n`);
  };
  return (cmd) =>
    new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', cmd], {
        cwd: projectRoot,
        env: { ...process.env, PATH: `${join(projectRoot, 'bin')}:${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8'); });
      child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        tee(cmd, out, err);
        if (code === 0) return resolve(out);
        const stderr = err.trim();
        const head = stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? 'command failed';
        reject(new Error(`exit ${code ?? '?'}: ${head}${stderr ? `\n${stderr}` : ''}`));
      });
    });
}

/**
 * Streaming host exec for `nc:run effect:step`. Spawns the step through a shell,
 * tees its human-facing output to the operator's terminal live (so a pairing code
 * card or a QR rendered by the step shows), parses the `=== NANOCLAW SETUP: TYPE
 * ===` status blocks, and resolves with the terminal (last STATUS-bearing) block's
 * fields so the engine can `capture:<var>=<FIELD>` them. The block protocol mirrors
 * setup/lib/runner.ts's StatusStream — a step is just a command that emits blocks.
 */
export function hostExecStream(projectRoot: string): (cmd: string) => Promise<StepOutcome> {
  return (cmd) =>
    new Promise((resolve) => {
      const child = spawn('bash', ['-c', cmd], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PATH: `${join(projectRoot, 'bin')}:${process.env.PATH ?? ''}`,
          // A step renders curated operator UI (a code card, a QR) — the host
          // logger's info noise doesn't belong on the wizard screen, and it
          // always emits ANSI so it can't be filtered by stream. Warnings and
          // errors still pass. An operator-set LOG_LEVEL wins (debugging).
          LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
          // The child's stdout is a pipe, so picocolors would strip its clack
          // rendering to bare box chars that clash with the wizard theme.
          // When the OPERATOR's terminal is a real TTY, the teed lines land
          // there — force color so the child's card matches the parent.
          ...(process.stdout.isTTY ? { FORCE_COLOR: '1' } : {}),
        },
        stdio: ['inherit', 'pipe', 'pipe'],
      });
      const blocks: Array<{ fields: Record<string, string> }> = [];
      let current: { fields: Record<string, string> } | null = null;
      let buf = '';
      const onChunk = (chunk: Buffer): void => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (/^=== NANOCLAW SETUP: \S+ ===/.test(line)) { current = { fields: {} }; continue; }
          if (line.startsWith('=== END ===')) { if (current) blocks.push(current); current = null; continue; }
          if (current) {
            const c = line.indexOf(':');
            if (c > 0) current.fields[line.slice(0, c).trim()] = line.slice(c + 1).trim();
            continue;
          }
          process.stdout.write(line + '\n'); // operator-facing line (a QR, a code) — show it live
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.on('close', (code) => {
        const terminal = [...blocks].reverse().find((b) => b.fields.STATUS) ?? null;
        const status = terminal?.fields.STATUS;
        resolve({ ok: code === 0 && (status === 'success' || status === 'skipped'), fields: terminal?.fields ?? {} });
      });
    });
}

// The barrier-confirm wording per gate flavor (§5.1.5). Decline = proceed: the
// barrier is a PAUSE, not a branch — the result is deliberately discarded, and
// the handler never throws for a decline (an operator-event throw would bounce
// and latch the engine's `blocked` gate over later side effects).
const GATE_WORDING: Record<'readiness' | 'completed', string> = {
  readiness: 'Ready? The next step starts immediately.',
  completed: "Done with the steps above? Continue when you're ready.",
};

/**
 * Where several steps under one heading share a spinner caption (a build and a
 * test both labelled "5. Build and validate"), suffix an ordinal — "(1/2)",
 * "(2/2)" — so consecutive spinners read as distinct steps, not a stutter.
 * Keyed by directive line (the step events carry it). Counting is static
 * (document order over the parsed directives); a runtime-skipped sibling can
 * leave a gap in the rendered sequence — cosmetic only.
 */
export function labelOrdinals(md: string): Map<number, string> {
  const byLabel = new Map<string, number[]>();
  for (const d of parseDirectives(md)) {
    const label = stepLabel(d, md);
    if (label === null) continue;
    const lines = byLabel.get(label) ?? [];
    lines.push(d.line);
    byLabel.set(label, lines);
  }
  const out = new Map<number, string>();
  for (const lines of byLabel.values()) {
    if (lines.length < 2) continue;
    lines.forEach((ln, i) => out.set(ln, ` (${i + 1}/${lines.length})`));
  }
  return out;
}

/**
 * The driver's DEFAULT `onEvent` handler — the whole wizard presentation policy:
 *
 *   • step-start/step-end → a per-step clack spinner (built on runner.ts's
 *     `startSpinner`), TTY-gated so piped/CI/test runs stay quiet. A null label
 *     is the engine's instant/renders-its-own-output declaration — no spinner.
 *     Repeated captions under one heading get an ordinal suffix (labelOrdinals).
 *   • operator → render the block as a clack note, then the URL offer
 *     (extractOfferUrl → confirm → openUrl), then the natural-barrier confirm
 *     when gatePolicy says this block precedes a side-effecting directive.
 *
 * An INJECTED `onEvent` replaces this handler entirely (the injector owns its
 * I/O) — which is why driver-policy tests run this default and inject the
 * `confirm`/`openUrl` seams instead.
 */
function defaultOnEvent(
  md: string,
  confirm: (message: string) => Promise<boolean>,
  open: (url: string) => Promise<void>,
): (e: ApplyEvent) => Promise<void> {
  const gates = gatePolicy(md);
  const ordinals = labelOrdinals(md);
  let active: ReturnType<typeof startSpinner> | null = null;
  return async (e) => {
    if (e.type === 'step-start') {
      if (!process.stdout.isTTY || e.label === null) return; // quiet: non-TTY, or instant/cheap step
      const base = e.label.replace(/…+$/, '') + (ordinals.get(e.line) ?? '');
      active = startSpinner({ running: `${base}…`, done: base, failed: `${base} failed` });
      return;
    }
    if (e.type === 'step-end') {
      if (!active) return; // never started a spinner for this one
      active.stop({ ok: e.ok });
      active = null;
      return;
    }
    // operator: note → URL offer → natural-barrier confirm.
    p.note(e.text, 'Your turn');
    const url = extractOfferUrl(e.text);
    if (url !== undefined && (await confirm(`Open ${url} in your browser?`))) await open(url);
    const gate = gates.get(e.line);
    // Decline = proceed (result discarded): the confirm is a pause so a manual
    // UI step is finished first — never an abort, never a throw.
    if (gate?.needsConfirm) await confirm(GATE_WORDING[gate.flavor]);
  };
}

/** Fork-aware registry-branch remote (same resolver setup/channels/slack.ts uses). */
function channelsRemote(projectRoot: string): () => string {
  return () =>
    execSync('source setup/lib/channels-remote.sh; resolve_channels_remote', {
      cwd: projectRoot,
      shell: '/bin/bash',
      encoding: 'utf8',
    }).trim();
}

export interface RunSkillOptions {
  projectRoot?: string;
  /** Pre-supplied prompt answers — pass them all for a fully programmatic run. */
  inputs?: Record<string, string>;
  /**
   * Resolve a prompt var the caller didn't pre-supply. Defaults to the clack
   * collector (`clackResolveInput` — masked secrets, validate re-ask loop, `?`
   * help-escape); inject a fake for tests or a relay for a coding agent.
   */
  resolveInput?: (name: string, meta: InputMeta) => Promise<string | undefined>;
  /** Defaults to `hostExec`. */
  exec?: (cmd: string) => string | void | Promise<string | void>;
  /** Defaults to `hostExecStream`. Streaming exec for `nc:run effect:step`. */
  execStream?: (cmd: string) => Promise<StepOutcome>;
  /** Defaults to the fork-aware channels-branch resolver. */
  resolveRemote?: (branch: string) => string;
  /** Run effects the caller owns (e.g. `['restart']` when it restarts once). */
  skipEffects?: string[];
  /** Offer to reuse credentials already in `.env` instead of re-prompting. */
  reuse?: boolean;
  /**
   * Consumer for every engine emission (step events + operator blocks). When
   * injected it REPLACES the driver's default policy handler ENTIRELY — the
   * spinner, the note, the URL offer, and the natural-barrier confirm are all
   * the default handler's; the injector owns its I/O. To observe the default
   * policy in tests, inject `confirm`/`openUrl` instead.
   */
  onEvent?: (e: ApplyEvent) => void | Promise<void>;
  /**
   * Yes/no seam used by the reuse offer, the natural-barrier gate, and the URL
   * offer. Defaults to a clack confirm, TTY-gated like the spinner — a non-TTY
   * run resolves true (proceed) so a headless run with full inputs never stalls.
   */
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Browser-open seam for the URL offer, attempted only after a `confirm` yes.
   * Defaults to setup/lib/browser.ts `openUrl` (headless ⇒ no-op).
   */
  openUrl?: (url: string) => Promise<void>;
  /**
   * Handoff context for the `?` help-escape (Step 8 / mechanism M3), threaded
   * into the default `clackResolveInput`. A lone `?` at any prompt hands the
   * operator off to interactive Claude with this `channel` + `step` label, then
   * re-asks. Ignored when an explicit `resolveInput` is injected (the injector
   * owns its I/O).
   */
  channel?: string;
  step?: string;
}

/**
 * Run a SKILL.md end-to-end through the directive engine with host-wired I/O.
 * Returns the engine's result; `fullyApplied(res)` tells the caller whether the
 * run completed or left prompts deferred / steps for an agent.
 */
export async function runSkill(skillDir: string, opts: RunSkillOptions = {}): Promise<ApplyResult> {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const confirm = opts.confirm ?? defaultConfirm;
  const open = opts.openUrl ?? defaultOpenUrl;
  let inputs = opts.inputs;
  // Offer to reuse credentials already in .env before the engine prompts for them.
  if (opts.reuse) {
    const reused = await reuseFromEnv(skillDir, projectRoot, inputs ?? {}, confirm);
    if (Object.keys(reused).length) inputs = { ...inputs, ...reused };
  }
  // The default operator policy derives from the skill document itself
  // (gatePolicy keys on directive lines) — read it once here; the engine reads
  // the same file for the actual apply.
  let md = '';
  try {
    md = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  } catch {
    // missing SKILL.md — the engine will produce an empty result anyway
  }
  // One raw log per skill apply (level 3): every default-exec command appends
  // its `$ cmd` + output there. Allocated only when the default exec is used —
  // an injected exec (tests, agent relay) owns its own capture.
  let rawLog: string | undefined;
  if (!opts.exec) {
    rawLog = setupLog.stepRawLog(`skill-${basename(skillDir)}`);
    writeFileSync(rawLog, `# skill ${basename(skillDir)} — ${new Date().toISOString()}\n\n`);
  }
  return applySkill(skillDir, projectRoot, {
    inputs,
    resolveInput: opts.resolveInput ?? clackResolveInput({ channel: opts.channel, step: opts.step }),
    onEvent: opts.onEvent ?? defaultOnEvent(md, confirm, open),
    exec: opts.exec ?? hostExec(projectRoot, rawLog),
    execStream: opts.execStream ?? hostExecStream(projectRoot),
    resolveRemote: opts.resolveRemote ?? channelsRemote(projectRoot),
    skipEffects: opts.skipEffects,
  });
}

// CLI: pnpm exec tsx setup/lib/skill-driver.ts <skillDir>   — apply a skill interactively.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    const skillDir = process.argv[2];
    if (!skillDir) {
      console.error('usage: pnpm exec tsx setup/lib/skill-driver.ts <skillDir>');
      process.exit(2);
    }
    p.intro(`Applying ${skillDir}`);
    const res = await runSkill(skillDir);
    if (fullyApplied(res)) {
      p.outro('Done — fully applied.');
    } else {
      if (res.deferred.length) p.log.warn(`No value yet for: ${res.deferred.join(', ')}`);
      for (const t of res.agentTasks) p.log.warn(`Needs an agent (${t.kind}): ${t.reason}`);
      p.outro('Applied with gaps — see above.');
    }
  })();
}
