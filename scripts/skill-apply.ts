// The skill application engine — executes `nc:` directives parsed from a SKILL.md.
//
// The agent is always the top-level applier; this engine is the deterministic
// accelerator it delegates to. Anything the engine can't do bounces back to the
// AGENT (which reads the same prose and applies it, the way skills work today) —
// never to the human, and never as a hard abort. The human is in the loop only
// for `prompt` inputs and `operator` instructions — the parts addressed to the
// human (e.g. clicking through the Slack UI), which the agent relays.
//
// Phases (the F2 runtime contract, minimal form):
//   1. parse + validate   — lint; a malformed skill never reaches apply
//   2. PLAN               — per directive: skip|apply|needs-input|agent — no writes
//   3. acquire inputs     — resolve every `prompt` via `inputs` / `resolveInput`
//   4. mutate             — copy/append/env-set, journaled + idempotent
//   5. run                — build/test/fetch (+ dep install) via injected exec
// Remove is derived from the journal — no hand-written REMOVE.md.
//
// Inputs + `resolveInput` make one engine serve three contexts:
//   • programmatic    → pass `inputs` (var→value); no resolver, runs through fully
//   • setup flow      → an interactive `resolveInput` collects anything left
//   • recipe rebuild  → headless: no answer for a prompt ⇒ it (and its consumers) defer
//
// Usage: pnpm exec tsx scripts/skill-apply.ts <skillDir>     # plan (no writes)

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, appendFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parseDirectives, promptVar, type Directive } from './skill-directives.js';

// What an `nc:prompt` DECLARES about the value it needs — the core seam's input
// contract, passed to `resolveInput` so a consumer can run its OWN re-ask loop
// (clack validate, a chat exchange). Declaration only: how the value is
// ACQUIRED (a masked TTY prompt, a chat message) is the consumer's business.
export interface InputMeta {
  question: string; // the prompt body (verbatim)
  secret: boolean; // consumer must mask
  validate?: string; // regex source (nc:prompt validate:<re>)
  flags?: string; // regex flags   (nc:prompt flags:<f>)
  normalize?: 'trim' | 'rstrip-slash' | 'lower'; // applied by the ENGINE at bind
}

// Everything the engine EMITS — the core seam's output contract. Every
// `onEvent` call is AWAITED before the engine proceeds; that ordering guarantee
// is what lets a consumer implement gating (hold the operator event until the
// human confirms readiness). For step events, `label` is `stepLabel`'s
// declaration: null means the step is instant/cheap, OR it renders its own live
// operator-facing output (an `effect:step` QR card / pairing code) — a
// step-cost/interactivity declaration, not render advice; the event carries
// `kind` + `line`, so a consumer wanting a different render policy can derive
// its own.
export type ApplyEvent =
  | { type: 'step-start'; kind: string; line: number; label: string | null }
  | { type: 'step-end'; kind: string; line: number; label: string | null; ok: boolean; durationMs: number; error?: string }
  | { type: 'operator'; line: number; text: string };
// operator: text = the rendered, {{var}}-substituted block body;
//           line = the directive's opening-fence line (keys driver policy maps)

// The result of a streaming `nc:run effect:step`: the spawn's exit success plus
// the terminal status block's fields, which `capture:<var>=<FIELD>` binds.
export interface StepOutcome {
  ok: boolean;
  fields: Record<string, string>;
}

export type StepStatus = 'skip' | 'apply' | 'needs-input' | 'agent';
export interface PlanStep {
  n: number;
  kind: string;
  line: number;
  status: StepStatus;
  detail: string;
}

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const has = (root: string, rel: string) => existsSync(join(root, rel));
const VAR_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const destOf = (line: string) => (line.includes('->') ? line.split('->')[1].trim() : line.trim());
const srcOf = (line: string) => (line.includes('->') ? line.split('->')[0].trim() : line.trim());

function fileHasLine(root: string, rel: string, line: string): boolean {
  return read(join(root, rel))
    .split('\n')
    .some((l) => l.trim() === line.trim());
}
function pkgHasDep(root: string, name: string): boolean {
  try {
    const pkg = JSON.parse(read(join(root, 'package.json')) || '{}');
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}
function envKeySet(root: string, key: string): boolean {
  return read(join(root, '.env'))
    .split('\n')
    .some((l) => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      return m !== null && m[1] === key && m[2].trim().length > 0;
    });
}
// Does the array-of-objects JSON at `rel` already contain an element whose
// [key] equals `value`? The idempotency probe for json-merge.
function jsonArrayHasKey(root: string, rel: string, key: string, value: unknown): boolean {
  try {
    const arr = JSON.parse(read(join(root, rel)) || '[]');
    return Array.isArray(arr) && arr.some((el) => el !== null && typeof el === 'object' && (el as Record<string, unknown>)[key] === value);
  } catch {
    return false;
  }
}

// Per-directive idempotency check + "what it would do". Read-only.
function selfStatus(d: Directive, root: string): { status: StepStatus; detail: string } {
  switch (d.kind) {
    case 'copy': {
      const dests = d.body.map(destOf);
      const missing = dests.filter((p) => !has(root, p));
      const from = d.attrs['from-branch'] ? `fetch ${String(d.attrs['from-branch'])} → ` : '';
      return missing.length
        ? { status: 'apply', detail: `${from}copy ${missing.join(', ')} (absent)` }
        : { status: 'skip', detail: `${dests.join(', ')} present` };
    }
    case 'append': {
      const to = String(d.attrs.to ?? '');
      const line = d.body[0] ?? '';
      return fileHasLine(root, to, line)
        ? { status: 'skip', detail: `${to} already has the line` }
        : { status: 'apply', detail: `add to ${to}: ${line}` };
    }
    case 'dep': {
      const missing = d.body.filter((s) => !pkgHasDep(root, s.slice(0, s.lastIndexOf('@'))));
      return missing.length
        ? { status: 'apply', detail: `install ${missing.join(', ')}` }
        : { status: 'skip', detail: `${d.body.join(', ')} present` };
    }
    case 'run':
      return { status: 'apply', detail: `${String(d.attrs.effect ?? 'run')}: ${d.body.join(' && ')}` };
    case 'env-set': {
      const keys = d.body.map((l) => l.split('=')[0].trim());
      const missing = keys.filter((k) => !envKeySet(root, k));
      return missing.length
        ? { status: 'apply', detail: `set ${missing.join(', ')} in .env` }
        : { status: 'skip', detail: `${keys.join(', ')} already set` };
    }
    case 'json-merge': {
      const into = String(d.attrs.into ?? '');
      const key = String(d.attrs.key ?? '');
      let value: unknown;
      try {
        value = (JSON.parse(d.body.join('\n')) as Record<string, unknown>)[key];
      } catch {
        return { status: 'agent', detail: `nc:json-merge body is not parseable JSON — an agent applies it from the prose` };
      }
      return jsonArrayHasKey(root, into, key, value)
        ? { status: 'skip', detail: `${into} already has ${key}=${JSON.stringify(value)}` }
        : { status: 'apply', detail: `merge ${key}=${JSON.stringify(value)} into ${into}` };
    }
    case 'prompt':
      return { status: 'needs-input', detail: '' };
    case 'operator':
      return { status: 'apply', detail: `show operator: ${(d.body[0] ?? '').slice(0, 50)}…` };
    default:
      return { status: 'agent', detail: `no deterministic handler for nc:${d.kind} — an agent applies it from the prose` };
  }
}

export function planSkill(skillDir: string, root: string): { steps: PlanStep[]; needsInput: string[]; agentSteps: number } {
  const directives = parseDirectives(read(join(skillDir, 'SKILL.md')));
  const self = directives.map((d) => ({ d, ...selfStatus(d, root) }));

  const consumers = new Map<string, number[]>();
  self.forEach(({ d }, i) => {
    for (const line of d.body) for (const m of line.matchAll(VAR_REF)) (consumers.get(m[1]) ?? consumers.set(m[1], []).get(m[1])!).push(i);
  });

  const steps: PlanStep[] = self.map(({ d, status, detail }, i) => {
    if (d.kind !== 'prompt') return { n: i + 1, kind: d.kind, line: d.line, status, detail };
    const v = promptVar(d) ?? '?';
    const tag = `${v}${d.args.includes('secret') ? ' (secret)' : ''}`;
    const cons = consumers.get(v) ?? [];
    const satisfied = cons.length > 0 && cons.every((j) => self[j].status === 'skip');
    return satisfied
      ? { n: i + 1, kind: d.kind, line: d.line, status: 'skip', detail: `${tag} — consumers already satisfied` }
      : { n: i + 1, kind: d.kind, line: d.line, status: 'needs-input', detail: `${tag} → asked during apply` };
  });

  return {
    steps,
    needsInput: steps.filter((s) => s.status === 'needs-input').map((s) => s.detail.split(' ')[0]),
    agentSteps: steps.filter((s) => s.status === 'agent').length,
  };
}

// ---------------------------------------------------------------------------
// Apply (phases 3–5) + journal-derived remove.
// ---------------------------------------------------------------------------

export type JournalEntry =
  | { op: 'wrote'; path: string }
  | { op: 'appended'; path: string; line: string }
  | { op: 'set-env'; key: string }
  | { op: 'json-merge'; path: string; key: string; value: unknown }
  | { op: 'ran'; cmd: string; undo?: string };

export interface AgentTask {
  kind: string;
  line: number;
  reason: string;
  prose: string; // the surrounding prose the agent reads to apply the step
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  deferred: string[]; // prompt vars / blocked consumers with no value yet
  agentTasks: AgentTask[]; // bounced to an agent — NOT the human
  operatorMessages: string[]; // `nc:operator` bodies to relay to the human operator
  // Non-secret resolved values (prompt answers + `run capture:<var>` outputs) so
  // a caller can read what the skill produced — e.g. a channel skill resolves
  // `owner_handle` + `platform_id`, the setup flow reads them to wire the agent.
  vars: Record<string, string>;
  journal: JournalEntry[];
  // The skill's author-written REFERENCE floor — its `## Alternatives`,
  // `## Optional configuration`, and `## Troubleshooting` sections, sliced
  // verbatim from the RAW markdown (see `referenceProse`). The driver surfaces
  // this beside the agentTasks on a bounce: the same prose a human reader would
  // scroll to when a step doesn't apply cleanly. Sliced on the author headings,
  // never the resolved {{var}} map, so a resolved {{secret}} can never leak in.
  referenceProse: string;
}

export interface ApplyOptions {
  // Pre-supplied answers for `prompt` vars (var name → value). Checked FIRST, so
  // a caller that has every answer needs no resolver at all and the whole skill
  // runs through with no human interaction (fully programmatic apply).
  inputs?: Record<string, string>;
  // The core input seam: resolve a prompt var the caller didn't pre-supply.
  // `meta` carries the declared semantics (question, secret,
  // validate/flags/normalize) so a consumer can run its OWN re-ask loop.
  // Returning undefined ⇒ defer. Optional — omit it (with full `inputs`) for a
  // headless run; a prompt with neither defers.
  resolveInput?: (name: string, meta: InputMeta) => Promise<string | undefined>;
  // The core output seam: every engine emission — the step-start/step-end
  // brackets and each rendered `nc:operator` block — flows through this one
  // handler, and every call is AWAITED before the engine proceeds (that
  // ordering is what lets a consumer gate on an operator block). A rejection is
  // treated like any other throw at that directive: bounce, never crash — a
  // consumer that throws on an operator event accepts the bounce consequence,
  // including the `blocked` latch cascading over later side effects. Absent ⇒
  // silent; the headless/programmatic apply runs identically.
  onEvent?: (e: ApplyEvent) => void | Promise<void>;
  // dep/run/branch-fetch; injectable for tests. Returns the command's stdout so
  // a `run capture:<var>` can bind it into a {{var}} (the twin of `prompt`).
  exec?: (cmd: string) => string | void | Promise<string | void>;
  // Streaming exec for `nc:run effect:step`: spawns a long-running, operator-
  // interactive step (a pairing code, a QR device-link) that emits
  // `=== NANOCLAW SETUP: … ===` status blocks, renders them to the operator live,
  // and resolves with the terminal block's fields (bound via capture:<var>=<FIELD>).
  // Absent ⇒ a step directive degrades to an agent (runs the step from the prose).
  execStream?: (cmd: string) => Promise<StepOutcome>;
  // Run effects the CALLER owns and will perform itself — those runs are skipped
  // (not executed). e.g. a headless rebuild or a setup that restarts once at the
  // end passes ['restart']; applyProviderSkill passes ['build','test'].
  skipEffects?: string[];
  // Resolve which remote carries a `from-branch` registry branch. Defaults to a
  // generic resolver (env override → first remote that has the branch → origin);
  // setup injects one that reuses setup/lib/channels-remote.sh for exact parity.
  resolveRemote?: (branch: string) => string;
}

/**
 * True when a skill applied completely — nothing deferred for a missing input and
 * nothing bounced to an agent. The check a programmatic caller makes to confirm a
 * fully-headless run-through succeeded.
 */
export function fullyApplied(res: ApplyResult): boolean {
  return res.deferred.length === 0 && res.agentTasks.length === 0;
}

/**
 * The failure diagnosis for the FIRST directive that bounced to an agent, in
 * document order: a concise headline (the nearest section heading) plus the
 * bounced step's own prose as the hint. The setup driver surfaces this when a
 * channel skill doesn't fully apply — the prose beside the step that failed
 * becomes the operator's failure hint and the Claude-handoff context, instead
 * of a generic "couldn't finish" message. Returns undefined when nothing
 * bounced (e.g. a headless rebuild only left prompts deferred — not a failure).
 */
export function firstFailureHint(res: ApplyResult): { headline: string; hint: string } | undefined {
  const first = res.agentTasks[0];
  if (!first) return undefined;
  const hint = first.prose.trim();
  // The concise headline: the nearest `#`-heading the prose carries, stripped of
  // its markers; failing that, the first prose line; failing that, the reason.
  const lines = first.prose.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => l.startsWith('#'));
  const headline = heading ? heading.replace(/^#+\s*/, '').trim() : (lines[0] ?? first.reason);
  return { headline, hint };
}

// The author-written REFERENCE sections the apply engine ignores entirely:
// `## Alternatives`, `## Optional configuration`, `## Troubleshooting`. Matched
// on the heading text (lowercased), level-2 only.
const REFERENCE_HEADINGS = new Set(['alternatives', 'optional configuration', 'troubleshooting']);

/**
 * Slice a skill's reference floor out of its raw markdown — the
 * `## Alternatives` / `## Optional configuration` / `## Troubleshooting` sections
 * the engine never executes. This is the human floor a reader scrolls to (a
 * dedicated-number path, optional env knobs, dropped-symptom fixes); the driver
 * surfaces it beside the bounced agentTasks so the operator has the same
 * reference. Returned VERBATIM from the author text keyed on the headings — never
 * from the resolved {{var}} map — so a resolved {{secret}} can never leak into it
 * (a `{{token}}` placeholder, if a reference section ever wrote one, stays a
 * literal placeholder). Any stray `nc:` directive fence inside a section is
 * dropped: reference prose is plain bash/json/text only — an `nc:` block belongs
 * under Apply, never here. Fence state is tracked so a `# comment` line inside a
 * code block is never mistaken for a markdown heading that would end the slice.
 */
export function referenceProse(md: string): string {
  const sections: string[] = [];
  let cur: string[] | null = null; // lines of the section being collected, or null
  let fence: string | null = null; // open fence's info-string ('' for a bare fence), or null
  const keep = (line: string): void => {
    // Inside (or toggling) an `nc:` fence ⇒ drop; otherwise collect when capturing.
    if (cur && !(fence ?? '').startsWith('nc:')) cur.push(line);
  };
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) {
      if (fence === null) {
        fence = line.slice(3).trim();
        keep(line);
      } else {
        keep(line); // closing fence — `fence` still holds the opening info-string
        fence = null;
      }
      continue;
    }
    if (fence !== null) { keep(line); continue; } // fence body
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim().toLowerCase();
      if (level === 2 && REFERENCE_HEADINGS.has(text)) {
        if (cur) sections.push(cur.join('\n').trim());
        cur = [line]; // open a new reference section
      } else if (level <= 2) {
        if (cur) { sections.push(cur.join('\n').trim()); cur = null; } // a non-reference h1/h2 closes the slice
      } else if (cur) {
        cur.push(line); // a subsection (### …) inside a captured reference section
      }
      continue;
    }
    if (cur) cur.push(line);
  }
  if (cur) sections.push(cur.join('\n').trim());
  return sections.filter(Boolean).join('\n\n').trim();
}

// A hardcoded `origin` breaks forks where the registry branch lives on
// `upstream`. Generic mirror of channels-remote.sh: explicit override → the
// first remote that actually has the branch → origin.
function defaultResolveRemote(branch: string, root: string): string {
  const override = process.env.NANOCLAW_CHANNELS_REMOTE;
  if (override) return override;
  const cap = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      return '';
    }
  };
  const remotes = cap('git remote').split('\n').map((s) => s.trim()).filter(Boolean);
  const ordered = remotes.includes('origin') ? ['origin', ...remotes.filter((r) => r !== 'origin')] : remotes;
  for (const r of ordered) if (cap(`git ls-remote --heads ${r} ${branch}`).trim()) return r;
  return 'origin';
}

// The prose an agent reads when a step degrades: nearest heading + the
// paragraph immediately above the directive fence.
function proseFor(md: string, fenceLine1: number): string {
  const lines = md.split('\n');
  let i = fenceLine1 - 2;
  while (i >= 0 && lines[i].trim() === '') i--;
  const para: string[] = [];
  while (i >= 0 && lines[i].trim() !== '' && !lines[i].startsWith('#')) para.unshift(lines[i--]);
  let heading = '';
  for (let h = i; h >= 0; h--) if (lines[h].startsWith('#')) { heading = lines[h]; break; }
  return [heading, ...para].filter(Boolean).join('\n').trim();
}

// The nearest `#`-prefixed heading above a fence (the same upward scan proseFor
// uses), stripped of its leading `#`s — a concise caption for a step spinner.
function headingAbove(md: string, fenceLine1: number): string {
  const lines = md.split('\n');
  for (let h = fenceLine1 - 2; h >= 0; h--) {
    if (lines[h].startsWith('#')) return lines[h].replace(/^#+\s*/, '').trim();
  }
  return '';
}

// The run effects worth a spinner — the slow, operator-waits-on-it ones.
// `effect:step` is deliberately absent: it renders its own live operator output
// (a QR card, a pairing code) that a concurrent spinner would clobber, so it
// stays unlabelled (null) like the instant kinds.
const SPIN_EFFECTS = new Set(['build', 'test', 'fetch', 'wire', 'restart', 'external']);

/**
 * The human caption a consumer may show for a step. `null` is a DECLARATION,
 * not render advice: the step is instant/cheap (a local file copy, an env
 * write, a json-merge), or it renders its own live operator-facing output
 * (`effect:step`'s QR card / pairing code) — the step event still carries
 * `kind` + `line`, so a consumer wanting a different render policy can derive
 * its own. Labels are HEADING-DERIVED only: the caption is the nearest heading
 * above the directive (so a consumer's progress line reads like the section
 * it's in), falling back to a kind/effect default.
 */
export function stepLabel(d: Directive, md: string): string | null {
  const effect = typeof d.attrs.effect === 'string' ? d.attrs.effect : undefined;
  const spins =
    d.kind === 'dep' ||
    (d.kind === 'copy' && typeof d.attrs['from-branch'] === 'string') ||
    (d.kind === 'run' && (effect === undefined || SPIN_EFFECTS.has(effect)));
  if (!spins) return null;
  const heading = headingAbove(md, d.line);
  if (heading) return heading;
  if (d.kind === 'dep') return 'Installing dependencies';
  if (d.kind === 'copy') return 'Fetching files';
  const byEffect: Record<string, string> = {
    build: 'Building', test: 'Testing', fetch: 'Fetching',
    wire: 'Wiring', restart: 'Restarting', external: 'Running',
  };
  return (effect && byEffect[effect]) || 'Running';
}

// Deterministic input normalization applied AT BIND to every prompt value —
// `inputs` AND interactive answers alike — driven by `nc:prompt normalize:<how>`:
//   trim          strip leading/trailing whitespace
//   rstrip-slash  drop trailing slash(es) — a base URL with no trailing path
//   lower         lowercase
// Absent/unknown ⇒ a no-op (lint gates the known set). Doing it here, not in the
// consumer, means a programmatic `inputs` value and a typed answer land identically.
// Exported so the driver's reuse-offer pre-filter (§5.4) tests an `.env` value
// against the SAME normalize-then-validate the engine will apply at bind.
export function normalizeValue(value: string, normalize: string | undefined): string {
  switch (normalize) {
    case 'trim':
      return value.trim();
    case 'rstrip-slash':
      return value.replace(/\/+$/, '');
    case 'lower':
      return value.toLowerCase();
    default:
      return value;
  }
}

// The engine-applied normalize transforms (see `normalizeValue`) — the set
// InputMeta.normalize narrows to. Lint gates authorship to these; an unknown
// value simply isn't declared in the meta (and normalizeValue no-ops on it).
const NORMALIZE_KINDS: ReadonlySet<string> = new Set(['trim', 'rstrip-slash', 'lower']);

// The InputMeta an `nc:prompt` declares — handed to `resolveInput` so a
// consumer can run its own re-ask loop against the same semantics the engine
// enforces at bind. The attrs live on the directive fence, so they're stripped
// along with the fence when a skill degrades to prose — invisible to the agent.
function inputMetaOf(d: Directive, secret: boolean, validate: string | undefined): InputMeta {
  const meta: InputMeta = { question: d.body.join('\n'), secret };
  if (validate !== undefined) meta.validate = validate;
  if (typeof d.attrs.flags === 'string') meta.flags = d.attrs.flags;
  if (typeof d.attrs.normalize === 'string' && NORMALIZE_KINDS.has(d.attrs.normalize)) {
    meta.normalize = d.attrs.normalize as InputMeta['normalize'];
  }
  return meta;
}

function substitute(value: string, vars: Map<string, { value: string; secret: boolean }>): string {
  return value.replace(VAR_REF, (_, name) => {
    const v = vars.get(name);
    if (!v) throw new Error(`unresolved {{${name}}}`);
    return v.value;
  });
}

// A `when:<var>=<value>` guard: the directive applies only when an earlier
// prompt/capture bound <var> to exactly <value>. Unmet — including the var still
// unresolved (a deferred prompt) — skips the directive, so a guarded prompt is
// skipped, never deferred. This is how a skill expresses mutually-exclusive
// branches (e.g. local vs remote install mode) in plain document order.
function whenMet(when: string, vars: Map<string, { value: string; secret: boolean }>): boolean {
  const eq = when.indexOf('=');
  if (eq < 1) return true; // malformed → don't block (lint is the gate)
  return vars.get(when.slice(0, eq).trim())?.value === when.slice(eq + 1).trim();
}

// Resolve a jq-style dot-path (`.id`, `.owner.id`) into a parsed JSON value.
// A missing/non-object hop yields undefined — the caller coerces that to ''.
function dotPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.replace(/^\./, '').split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

// Bind a `run capture:<spec>` from a command's stdout into one or more {{vars}}.
//   • bare `capture:var`           → binds the trimmed stdout as-is (unchanged).
//   • `capture:a=.x,b=.owner.id`   → parses the stdout as JSON and binds each var
//                                     to its dot-path, so ONE API call resolves
//                                     several values (the structured twin of the
//                                     effect:step terminal-block capture — those
//                                     two are distinguished by effect: step reads
//                                     the status block, fetch/external read JSON
//                                     stdout). Unparseable JSON throws → the outer
//                                     catch bounces it to an agent.
// An optional `validate:<re>` is enforced against every bound value; a mismatch
// THROWS so the run bounces to an agent — a command's output has no human to
// re-prompt, so an invalid capture is a real failure, not a re-ask.
function bindCapture(
  spec: string,
  stdout: string,
  validate: string | undefined,
  vars: Map<string, { value: string; secret: boolean }>,
): void {
  const re = validate ? new RegExp(validate) : undefined;
  const set = (name: string, value: string): void => {
    if (re && !re.test(value)) throw new Error(`captured ${name}="${value}" does not match validate:${validate}`);
    vars.set(name, { value, secret: false });
  };
  if (!spec.includes('=')) {
    set(spec, stdout);
    return;
  }
  const json = JSON.parse(stdout) as unknown; // not JSON → throws → outer catch bounces
  for (const pair of spec.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    set(pair.slice(0, eq).trim(), String(dotPath(json, pair.slice(eq + 1).trim()) ?? ''));
  }
}

// The mutating twin of selfStatus. Records what it did to the journal so remove
// is derivable. Throws on failure → caught and bounced to an agent.
async function applyOne(
  d: Directive,
  ctx: { root: string; skillDir: string; exec: (c: string) => string | void | Promise<string | void>; execStream?: (c: string) => Promise<StepOutcome>; resolveRemote: (b: string) => string; vars: Map<string, { value: string; secret: boolean }>; journal: JournalEntry[] },
): Promise<void> {
  const { root, skillDir, exec, vars, journal } = ctx;
  switch (d.kind) {
    case 'copy':
      if (d.attrs['from-branch']) {
        const b = String(d.attrs['from-branch']);
        const remote = ctx.resolveRemote(b);
        await exec(`git fetch ${remote} ${b}`);
        for (const l of d.body) {
          // The shell redirect can't create parent directories, and the dest
          // may not exist on trunk (e.g. container skills that live only on
          // the channels branch). Mirror the local-copy path's mkdir.
          mkdirSync(dirname(join(root, destOf(l))), { recursive: true });
          await exec(`git show ${remote}/${b}:${srcOf(l)} > ${destOf(l)}`);
        }
      } else {
        for (const l of d.body) {
          const dst = join(root, destOf(l));
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(join(skillDir, srcOf(l)), dst);
        }
      }
      for (const l of d.body) journal.push({ op: 'wrote', path: destOf(l) });
      break;
    case 'append': {
      const to = String(d.attrs.to);
      const marker = typeof d.attrs.at === 'string' ? d.attrs.at : undefined;
      const target = join(root, to);
      if (marker) {
        // Insert before the `// <<< <marker>` closing line of a dormant marker
        // region, matching that line's indentation. removeSkill still deletes
        // by line (position-agnostic), so the journal entry is unchanged.
        const close = `<<< ${marker}`;
        for (const line of d.body) {
          const lines = read(target).split('\n');
          const idx = lines.findIndex((l) => l.includes(close));
          if (idx === -1) throw new Error(`append marker "${marker}" not found in ${to}`);
          const indent = lines[idx].match(/^\s*/)?.[0] ?? '';
          lines.splice(idx, 0, indent + line);
          writeFileSync(target, lines.join('\n'));
          journal.push({ op: 'appended', path: to, line });
        }
      } else {
        for (const line of d.body) {
          appendFileSync(target, (read(target).endsWith('\n') || read(target) === '' ? '' : '\n') + line + '\n');
          journal.push({ op: 'appended', path: to, line });
        }
      }
      break;
    }
    case 'dep': {
      await exec(`pnpm add ${d.body.join(' ')}`);
      const names = d.body.map((s) => s.slice(0, s.lastIndexOf('@'))).join(' ');
      journal.push({ op: 'ran', cmd: `pnpm add ${d.body.join(' ')}`, undo: `pnpm remove ${names}` });
      break;
    }
    case 'run': {
      // `capture:<var>` binds the command's stdout into a {{var}} — the twin of
      // `prompt` (which binds human input). Lets a run resolve a value from an
      // API (e.g. Slack conversations.open → the DM channel id) and feed it to a
      // later directive, so a flow that validates/resolves stays pure directives.
      const capture = typeof d.attrs.capture === 'string' ? d.attrs.capture : undefined;
      // A `validate:<re>` shape-guard the stdout capture enforces (see bindCapture).
      const validate = typeof d.attrs.validate === 'string' ? d.attrs.validate : undefined;
      // effect:check runs the body as a shell PREDICATE — a precondition gate
      // that mutates NOTHING. It pushes no journal entry and binds no capture: a
      // zero exit is a silent pass; a non-zero exit throws → the outer catch
      // bounces it to an agent (which reads the prose and decides); an unresolved
      // {{var}} throws from substitute first → deferred (like any other run, e.g.
      // a headless rebuild before the value is collected). Because a bounce here
      // latches `blocked`, a failed precondition gates the dangerous side effects
      // (a restart, a pairing/QR step, a wire) that follow — a broken local
      // config or an un-registered app never reaches a doomed restart/QR.
      if (d.attrs.effect === 'check') {
        for (const cmd of d.body) await exec(substitute(cmd, vars));
        break;
      }
      // effect:step runs a long-running, operator-interactive step (a pairing
      // code, a QR device-link) through the streaming exec and binds the terminal
      // status block's named fields via capture:<var>=<FIELD>[,…] — the structured,
      // multi-valued twin of stdout capture. No streaming exec ⇒ throw → an agent
      // runs the step from the prose (degrade, not crash).
      if (d.attrs.effect === 'step') {
        if (!ctx.execStream) throw new Error('effect:step needs a streaming exec — an agent runs the step from the prose');
        const { ok, fields } = await ctx.execStream(substitute(d.body.join('\n'), vars));
        if (!ok) throw new Error('the step did not complete');
        if (capture) {
          for (const pair of capture.split(',')) {
            const eq = pair.indexOf('=');
            if (eq < 1) continue;
            vars.set(pair.slice(0, eq).trim(), { value: (fields[pair.slice(eq + 1).trim()] ?? '').trim(), secret: false });
          }
        }
        journal.push({ op: 'ran', cmd: d.body.join('\n') });
        break;
      }
      for (const cmd of d.body) {
        // Interpolate prompted {{vars}} the same way env-set does, so a run can
        // call `ncl ... {{owner_email}}` to wire from collected input. A command
        // with no {{...}} (build/test) is returned unchanged; an unresolved var
        // throws → caught → deferred (the prompt hasn't been answered yet).
        const out = await exec(substitute(cmd, vars));
        // Last command wins for capture (a capture run should be a single command).
        // bindCapture binds stdout-as-is OR a multi-field JSON spec, and enforces
        // validate:<re> — a mismatch / unparseable JSON throws → bounced to an agent.
        if (capture) bindCapture(capture, typeof out === 'string' ? out.trim() : '', validate, vars);
        // Journal the ORIGINAL command (placeholders intact) — never the
        // substituted form — so a secret interpolated into a run never lands in
        // the journal (or a remove replay).
        const undo = d.attrs.effect === 'external' && typeof d.attrs.remove === 'string' ? d.attrs.remove : undefined;
        journal.push({ op: 'ran', cmd, undo });
      }
      break;
    }
    case 'env-set': {
      const envPath = join(root, '.env');
      for (const entry of d.body) {
        const eq = entry.indexOf('=');
        const key = entry.slice(0, eq).trim();
        const value = substitute(entry.slice(eq + 1).trim(), vars); // throws if a {{var}} is unresolved
        if (!envKeySet(root, key)) {
          appendFileSync(envPath, (read(envPath).endsWith('\n') || read(envPath) === '' ? '' : '\n') + `${key}=${value}\n`);
          journal.push({ op: 'set-env', key });
        }
      }
      break;
    }
    case 'json-merge': {
      const into = String(d.attrs.into);
      const key = String(d.attrs.key);
      const obj = JSON.parse(d.body.join('\n')) as Record<string, unknown>;
      const target = join(root, into);
      const arr = JSON.parse(read(target) || '[]') as unknown[];
      if (!Array.isArray(arr)) throw new Error(`${into} is not a JSON array`);
      const value = obj[key];
      // Idempotent: only push when no element already matches on the key.
      if (!arr.some((el) => el !== null && typeof el === 'object' && (el as Record<string, unknown>)[key] === value)) {
        arr.push(obj);
        writeFileSync(target, JSON.stringify(arr, null, 2) + '\n');
        journal.push({ op: 'json-merge', path: into, key, value });
      }
      break;
    }
    default:
      throw new Error(`no handler for nc:${d.kind}`);
  }
}

export async function applySkill(skillDir: string, root: string, opts: ApplyOptions): Promise<ApplyResult> {
  // Lint (validate()) is the authoring/CI gate, run before a skill ships — NOT
  // here. Apply is best-effort: an unknown directive (a typo lint should have
  // caught, or one newer than this engine) bounces to an agent, never blocks.
  const md = read(join(skillDir, 'SKILL.md'));
  const directives = parseDirectives(md);
  const exec = opts.exec ?? (() => { throw new Error('no exec provided'); });
  const resolveRemote = opts.resolveRemote ?? ((b: string) => defaultResolveRemote(b, root));
  const vars = new Map<string, { value: string; secret: boolean }>();
  const res: ApplyResult = { applied: [], skipped: [], deferred: [], agentTasks: [], operatorMessages: [], vars: {}, journal: [], referenceProse: referenceProse(md) };
  // A run-health gate: once ANY directive bounces to an agent, the skill is no
  // longer in a known-good state, so the dangerous side effects below must not
  // fire on their own — a live restart, an interactive pairing/QR step, or a wire
  // launched after an upstream failure just wastes the operator's time (a doomed
  // QR, a restart that loads a bad credential). `blocked` latches on the first
  // bounce; a later side-effecting run becomes its own bounce so the agent
  // finishes it from the prose once the upstream failure is fixed. A DEFERRED
  // prompt (headless rebuild, no answer) is not a failure — it never bounces, so
  // `blocked` stays false and a later restart remains runnable.
  let blocked = false;
  const SIDE_EFFECTS = new Set(['restart', 'step', 'wire']);
  const bounce = (d: Directive, reason: string) => {
    blocked = true;
    res.agentTasks.push({ kind: d.kind, line: d.line, reason, prose: proseFor(md, d.line) });
  };

  for (const d of directives) {
    // Tracks an in-flight step so the catch can always close a matching
    // step-end (start/end stay balanced even when applyOne throws — a consumer's
    // spinner is never orphaned). Set only after step-start fires.
    let inFlight: { label: string | null; at: number } | null = null;
    try {
      // A `when:<var>=<value>` guard that isn't met skips the directive entirely —
      // before prompt (so a guarded prompt is skipped, never deferred), operator,
      // and run handling. This is how mutually-exclusive branches coexist in one
      // skill while a fully-programmatic apply still completes.
      if (typeof d.attrs.when === 'string' && !whenMet(d.attrs.when, vars)) {
        res.skipped.push(`${d.kind}: when ${d.attrs.when} not met`);
        continue;
      }
      if (d.kind === 'prompt') {
        const v = promptVar(d)!;
        const secret = d.args.includes('secret');
        const validate = typeof d.attrs.validate === 'string' ? d.attrs.validate : undefined;
        const flags = typeof d.attrs.flags === 'string' ? d.attrs.flags : undefined;
        const normalize = typeof d.attrs.normalize === 'string' ? d.attrs.normalize : undefined;
        // Pre-supplied inputs win OUTRIGHT (fully-programmatic apply) — an
        // invalid `inputs` value never falls through to a second acquisition
        // path (validation below rejects it loudly instead). Otherwise resolve
        // via `resolveInput`; still undefined ⇒ defer (headless, no answer).
        let val = opts.inputs?.[v];
        if (val === undefined) val = await opts.resolveInput?.(v, inputMetaOf(d, secret, validate));
        if (val === undefined) { res.deferred.push(v); continue; }
        // normalize:<how> binds DETERMINISTICALLY for both inputs and answers, so
        // an `inputs` value and a typed one land identically (a trailing slash
        // stripped, whitespace trimmed) — see normalizeValue.
        const bound = normalizeValue(val, normalize);
        // Validate-at-bind: `validate:` (+ `flags:`) is DATA validation, enforced
        // on the NORMALIZED value no matter where it came from (normalize-then-
        // validate is normative: a trailing slash is stripped before an anchor
        // check). On a mismatch the var stays UNBOUND and only the var name +
        // regex source land in the deferred entry — never the value, so a secret
        // can't leak. Not an agentTask, not a throw: downstream consumers defer
        // exactly as if the value were never supplied, `fullyApplied` is false,
        // and a pipeline passing a malformed env value fails loudly. The
        // interactive re-ask loop lives in the consumer's `resolveInput`; this is
        // the backstop for programmatic paths.
        if (validate !== undefined && !new RegExp(validate, flags).test(bound)) {
          res.deferred.push(`${v}: invalid value (does not match validate:${validate})`);
          continue;
        }
        vars.set(v, { value: bound, secret });
        continue;
      }
      if (d.kind === 'operator') {
        // Once the run is blocked, walking the human through further manual
        // steps is actively misleading — the side effects those instructions
        // lead up to ("a pairing code is about to appear") have already been
        // gated. Skip: no event (so a consumer's URL offer / readiness confirm
        // never fires), no operatorMessages entry (a failed run's manual-steps
        // report must not include steps predicated on the failed one).
        if (blocked) {
          res.skipped.push('operator: skipped after an earlier failure');
          continue;
        }
        // Always collect the human-facing instructions into the result so a
        // programmatic caller can relay/output them. {{vars}} render so a
        // resolved value can be shown (throws → deferred if a referenced var is
        // unset — the whole block defers before any event fires).
        const text = substitute(d.body.join('\n'), vars);
        res.operatorMessages.push(text);
        // The core seam: emit the rendered block and AWAIT the consumer before
        // evaluating the next directive — that ordering is what lets a consumer
        // gate (hold the event until the human confirms readiness). The engine
        // itself never defers/bounces an operator block; a handler that throws
        // opts into the standard bounce path via the outer catch (including
        // the `blocked` latch over later side effects).
        if (opts.onEvent) await opts.onEvent({ type: 'operator', line: d.line, text });
        res.applied.push(`operator: ${(d.body[0] ?? '').slice(0, 50)}`);
        continue;
      }
      // A run whose effect the caller owns (e.g. restart) is skipped here.
      if (d.kind === 'run' && typeof d.attrs.effect === 'string' && opts.skipEffects?.includes(d.attrs.effect)) {
        res.skipped.push(`run ${d.attrs.effect}: owned by the caller`);
        continue;
      }
      // Run-health gate: after an earlier bounce, never fire a dangerous side
      // effect (a live restart, an interactive pairing/QR step, a wire) on its
      // own — bounce it too so the agent runs it from the prose once the upstream
      // failure is fixed. (A deferred prompt did NOT set `blocked`, so this only
      // trips on a real failure, never a headless rebuild's missing input.)
      if (d.kind === 'run' && typeof d.attrs.effect === 'string' && SIDE_EFFECTS.has(d.attrs.effect) && blocked) {
        bounce(d, 'skipped: an earlier step did not complete — run this from the prose after fixing it');
        continue;
      }
      const st = selfStatus(d, root);
      if (st.status === 'agent') { bounce(d, 'no deterministic handler'); continue; }
      if (st.status === 'skip') { res.skipped.push(`${d.kind}: ${st.detail}`); continue; }
      // Bracket the real mutation with step events so a consumer can render
      // progress. `label` null is a step-cost/interactivity declaration (see
      // `stepLabel`). `inFlight` is set only after step-start fires; the ok:true
      // step-end clears it BEFORE its own (awaited) emission, so a consumer
      // throw there never double-closes.
      const label = stepLabel(d, md);
      if (opts.onEvent) await opts.onEvent({ type: 'step-start', kind: d.kind, line: d.line, label });
      inFlight = { label, at: Date.now() };
      await applyOne(d, { root, skillDir, exec, execStream: opts.execStream, resolveRemote, vars, journal: res.journal });
      const durationMs = Date.now() - inFlight.at;
      inFlight = null;
      if (opts.onEvent) await opts.onEvent({ type: 'step-end', kind: d.kind, line: d.line, label, ok: true, durationMs });
      res.applied.push(`${d.kind}: ${st.detail}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Close the step as failed before classifying — keeps step-start/step-end
      // balanced whether the throw becomes a deferred (unresolved input) or a
      // bounce (a real failure, handled below). The failure-path close is
      // best-effort: a consumer that also throws here can't change the outcome —
      // we're already on the failure path.
      if (inFlight && opts.onEvent) {
        const end = { kind: d.kind, line: d.line, label: inFlight.label, ok: false, durationMs: Date.now() - inFlight.at, error: msg };
        try { await opts.onEvent({ type: 'step-end', ...end }); } catch { /* already failing — the close is best-effort */ }
      }
      if (/unresolved \{\{/.test(msg)) res.deferred.push(msg); // blocked on a prompt input
      else bounce(d, `engine could not apply (${msg}) — an agent applies it from the prose`);
    }
  }
  // Surface the non-secret resolved values for a caller to consume.
  for (const [k, v] of vars) if (!v.secret) res.vars[k] = v.value;
  return res;
}

// Remove is the journal played backwards — no hand-written REMOVE.md.
export async function removeSkill(root: string, journal: JournalEntry[], exec?: (c: string) => void | Promise<void>): Promise<void> {
  for (const e of [...journal].reverse()) {
    if (e.op === 'wrote') rmSync(join(root, e.path), { force: true });
    else if (e.op === 'appended') {
      const p = join(root, e.path);
      writeFileSync(p, read(p).split('\n').filter((l) => l.trim() !== e.line.trim()).join('\n'));
    } else if (e.op === 'set-env') {
      const p = join(root, '.env');
      writeFileSync(p, read(p).split('\n').filter((l) => !l.startsWith(`${e.key}=`)).join('\n'));
    } else if (e.op === 'json-merge') {
      const p = join(root, e.path);
      const arr = JSON.parse(read(p) || '[]') as unknown[];
      if (Array.isArray(arr)) {
        writeFileSync(p, JSON.stringify(arr.filter((el) => !(el !== null && typeof el === 'object' && (el as Record<string, unknown>)[e.key] === e.value)), null, 2) + '\n');
      }
    } else if (e.op === 'ran' && e.undo && exec) {
      await exec(e.undo);
    }
  }
}

// CLI — the planner (no writes)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const skillDir = process.argv[2];
  if (!skillDir) {
    console.error('usage: pnpm exec tsx scripts/skill-apply.ts <skillDir>');
    process.exit(2);
  }
  const root = process.cwd();
  const { steps, needsInput, agentSteps } = planSkill(skillDir, root);
  console.log(`PLAN ${skillDir}   project: ${root}\n`);
  const icon: Record<StepStatus, string> = { skip: '✓ skip', apply: '→ apply', 'needs-input': '? human', agent: '↳ agent' };
  for (const s of steps) console.log(`${String(s.n).padStart(2)}. ${icon[s.status].padEnd(8)} ${s.kind.padEnd(9)} ${s.detail}`);
  console.log(`\nneeds human input: ${needsInput.join(', ') || '(none)'}    →agent: ${agentSteps}`);
}
