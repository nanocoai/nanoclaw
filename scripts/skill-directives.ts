// Extract `nc:` skill directives embedded in a SKILL.md.
//
// A fenced code block whose info-string starts with `nc:` is a load-bearing
// directive; every other fence (and all prose) is the human floor the parser
// ignores. That is the whole "two readers, one document" property: an agent
// applies the prose, a tool applies the directives, and anything the tool
// can't handle degrades to the prose beside it. This is the seed for both the
// conformance linter and the deterministic applier.
//
// Grammar, derived from add-slack:
//
//   ```nc:<directive> <arg>... [key:value]...
//   <body line>
//   ```
//
// `prompt` only *acquires* a value and binds it to a name; a separate directive
// *applies* it, referenced as `{{name}}`. That keeps "ask the human" decoupled
// from "what you do with the answer" (env, ncl, the OneCLI vault, a file).
//
//   copy [from-branch:<b>]  body: `PATH` (src==dst) or `SRC -> DST`   overwrite
//   append to:<file> [at:<marker>]  body: line(s) to add             skip if present
//   dep [manager:pnpm]      body: `pkg@<exact-semver>` line(s)        reinstall no-op
//   run [effect:build|test|fetch|external|wire|restart|step|check] [capture:<spec>]  re-runnable
//        body: shell command(s). {{vars}} are substituted in. effect:wire runs
//        `ncl …` to wire collected input (no undo — the rows it creates are user
//        runtime data, not reversed on skill remove). effect:restart restarts the
//        service so following `ncl` runs reach it; a caller that owns the restart
//        (rebuild, or a setup that restarts once) skips it via ApplyOptions.
//        skipEffects. capture:<var> binds the command's stdout into {{var}} (twin
//        of prompt) — e.g. resolve an id from an API and feed it to a later step.
//        capture:<var>=<dot-path>[,<var2>=<dot-path2>…] parses the stdout as JSON
//        and binds each var to its jq-style dot-path (.id, .owner.id), so ONE API
//        call resolves several values at once. validate:<re> shape-guards each
//        captured value (e.g. validate:^discord:); a mismatch bounces the run to
//        an agent (a command's output has no human to re-prompt — unlike prompt).
//        effect:step runs a long-running, operator-interactive step (a pairing
//        code, a QR device-link) through the streaming exec: its
//        `=== NANOCLAW SETUP: … ===` status blocks render to the operator live and
//        `capture:<var>=<FIELD>[,<var2>=<FIELD2>…]` binds the terminal block's
//        named fields into {{vars}} (multi-valued, structured twin of stdout
//        capture). Degrades to an agent when no streaming exec is wired.
//        effect:check runs the body as a shell PREDICATE (a precondition gate):
//        it mutates nothing (no journal, no capture). A zero exit passes silently;
//        a non-zero exit bounces to an agent (degrade, not crash) and, via the
//        run-health gate, blocks the dangerous side effects that follow it (a
//        restart, a pairing/QR step, a wire). An unresolved {{var}} defers.
//   prompt <var> [secret] [validate:<re>] [flags:<re-flags>]
//          [normalize:trim|rstrip-slash|lower] [reuse:<ENV_KEY>]
//        body: the question → binds {{var}}                       skip if satisfied
//        validate:<re> is a regex enforced AT BIND for EVERY value — `inputs` and
//        interactive answers alike (e.g. validate:^xoxb- to require a Slack bot
//        token); a mismatch leaves the var unbound and records a deferred entry.
//        A minimum length is regex-encoded (e.g. validate:^.{20,}$).
//        flags:<re-flags> are regex flags applied to validate (e.g. flags:i → a
//        case-insensitive scheme match). normalize:<how> deterministically
//        transforms the value AT BIND, before validate — for BOTH `inputs` and
//        interactive answers — one of trim | rstrip-slash | lower.
//        reuse:<ENV_KEY> lets a re-run offer an existing .env value for a credential
//        a HELPER SCRIPT owns (written by effect:external, not nc:env-set) — the
//        masked reuse offer the env-set→ENV_KEY inference can't otherwise see.
//   operator                body: instructions for the human operator     output-only
//        The SKILL.md is addressed to the coding agent; `operator` delineates the
//        parts meant for the HUMAN (e.g. clicking through the Slack UI). Lead it
//        with agent-facing prose like "Tell the user:" so the agent relays it;
//        the engine renders the body to the operator ({{vars}} substituted in).
//        The block carries NO presentation attrs: a URL to visit lives in the
//        body prose (a consumer may offer to open it), and whether a consumer
//        pauses for confirmation before the next side effect is derived from
//        document structure (scripts/skill-policy.ts), never authored here.
//   env-set                 body: `KEY=value` ({{var}} allowed)       set-if-absent
//   json-merge into:<file> key:<field>  body: a JSON object          push-if-absent
//
// `append` without `at:` adds to EOF; with `at:<marker>` it inserts before the
// `// <<< <marker>` closing line of a dormant marker region (see setup/index.ts).
// `json-merge` reads an array-of-objects JSON file and pushes the body object
// unless an element already has body[key]===element[key] (idempotent by key).
//
// Any directive may carry `when:<var>=<value>` — a guard evaluated against an
// earlier prompt/capture var. If it doesn't match (including the var being
// unresolved), the directive is skipped — a guarded prompt is skipped, never
// deferred — so one skill can express mutually-exclusive branches (e.g. a local
// vs remote install mode) in document order while still running fully
// programmatically from `inputs`.
//
// Removed presentation attrs — `min:`/`error:` on prompt, `open:`/`gate` on
// operator, `label:`/`on-fail:` on any directive — are lint ERRORS, so stale
// authorship fails loudly instead of silently no-oping. Their jobs moved:
// length checks into validate: regexes, miss messages derive from the question
// prose, URLs live in the operator body, gating and step labels derive from
// document structure (scripts/skill-policy.ts / the preceding heading), and the
// failure hint is always the surrounding prose.
//
// Usage: pnpm exec tsx scripts/skill-directives.ts <SKILL.md>

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Directive {
  kind: string;
  args: string[]; // positional bare tokens, e.g. prompt's variable name
  attrs: Record<string, string | true>; // key:value tokens
  body: string[];
  line: number; // 1-based line of the opening fence
}

export interface Problem {
  line: number;
  kind: string;
  message: string;
}

const FENCE = /^```(\S.*)?$/;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const VAR_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const KNOWN = new Set(['copy', 'append', 'dep', 'run', 'prompt', 'operator', 'env-set', 'json-merge']);
// Retired directives get a targeted lint error (not just "unknown") so an
// author knows the removal was deliberate and what to do instead.
const RETIRED: Record<string, string> = {
  'env-sync': 'nc:env-sync was retired — nothing reads the data/env/env mirror (and it copied live tokens); delete the fence, the adapter reads .env directly',
};
const PROMPT_FLAGS = new Set(['secret']);

export function parseDirectives(markdown: string): Directive[] {
  const lines = markdown.split('\n');
  const out: Directive[] = [];
  let i = 0;
  while (i < lines.length) {
    const info = lines[i].match(FENCE)?.[1]?.trim();
    if (info === undefined) {
      i++;
      continue;
    }
    // A fence opens here; consume to its closing fence either way.
    let j = i + 1;
    const body: string[] = [];
    while (j < lines.length && !FENCE.test(lines[j])) {
      body.push(lines[j]);
      j++;
    }
    if (info.startsWith('nc:')) {
      const [tag, ...rest] = info.split(/\s+/);
      const args: string[] = [];
      const attrs: Record<string, string | true> = {};
      for (const tok of rest) {
        const eq = tok.indexOf(':');
        if (eq > 0) attrs[tok.slice(0, eq)] = tok.slice(eq + 1);
        else args.push(tok);
      }
      out.push({
        kind: tag.slice('nc:'.length),
        args,
        attrs,
        body: body.map((l) => l.trim()).filter(Boolean),
        line: i + 1,
      });
    }
    i = j + 1; // skip past the closing fence (directive or plain code block)
  }
  return out;
}

/** The variable a `prompt` binds (the first positional that isn't a flag). */
export function promptVar(d: Directive): string | undefined {
  return d.args.find((a) => !PROMPT_FLAGS.has(a));
}

/**
 * The variable name(s) a `run capture:<spec>` binds. `capture:dm_channel` →
 * `['dm_channel']` (stdout form); `capture:platform_id=PLATFORM_ID,owner=ACCOUNT`
 * → `['platform_id','owner']` (effect:step field form).
 */
export function captureVars(spec: string): string[] {
  if (!spec.includes('=')) return [spec];
  return spec
    .split(',')
    .map((pair) => pair.slice(0, pair.indexOf('=')).trim())
    .filter(Boolean);
}

/** `{{var}}` names referenced anywhere in a directive's body. */
function referencedVars(d: Directive): string[] {
  const found: string[] = [];
  for (const line of d.body) for (const m of line.matchAll(VAR_REF)) found.push(m[1]);
  return found;
}

/**
 * The resolved `chat` core version from our lockfile — the single source of
 * truth a `@chat-adapter/*` adapter pin must match (the adapter and the core
 * move in lockstep). Reads the root importer's direct `chat` dependency, whose
 * `specifier`/`version` pair is unique to importer deps (transitive entries in
 * the packages section have no `specifier`). Returns undefined if not found.
 */
export function resolveChatCoreVersion(root: string): string | undefined {
  let lock = '';
  try {
    lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const m = lock.match(/\n\s+chat:\n\s+specifier:[^\n]*\n\s+version:\s*([0-9][^\s(]*)/);
  return m?.[1];
}

export function validate(directives: Directive[], ctx?: { chatVersion?: string }): Problem[] {
  const problems: Problem[] = [];
  const defined = new Set<string>();
  const flag = (d: Directive, message: string) => problems.push({ line: d.line, kind: d.kind, message });
  for (const d of directives) {
    if (RETIRED[d.kind]) flag(d, RETIRED[d.kind]);
    else if (!KNOWN.has(d.kind)) flag(d, `unknown directive nc:${d.kind}`);
    switch (d.kind) {
      case 'dep':
        for (const spec of d.body) {
          const at = spec.lastIndexOf('@');
          const name = at > 0 ? spec.slice(0, at) : spec;
          const version = at > 0 ? spec.slice(at + 1) : '';
          if (!EXACT_SEMVER.test(version)) flag(d, `dep "${spec}" must pin an exact semver (no ranges/latest)`);
          // A @chat-adapter/* adapter must match the chat core version in our
          // lockfile — the family moves together. This catches pin drift (the
          // 4.27.0-vs-chat@4.26.0 mismatch) at lint time.
          if (ctx?.chatVersion && name.startsWith('@chat-adapter/') && version !== ctx.chatVersion) {
            flag(d, `${name} pinned ${version} but our chat core is ${ctx.chatVersion} — a @chat-adapter/* adapter must match the chat package`);
          }
        }
        break;
      case 'append':
        if (!d.attrs.to) flag(d, 'append requires to:<file>');
        if (d.body.length === 0) flag(d, 'append requires a line to add');
        break;
      case 'copy':
        if (d.body.length === 0) flag(d, 'copy requires at least one path');
        break;
      case 'json-merge': {
        if (!d.attrs.into) flag(d, 'json-merge requires into:<json-file>');
        if (!d.attrs.key) flag(d, 'json-merge requires key:<field>');
        if (d.body.length === 0) {
          flag(d, 'json-merge requires a JSON object in its body');
        } else {
          let obj: unknown;
          try {
            obj = JSON.parse(d.body.join('\n'));
          } catch {
            flag(d, 'json-merge body must be a single parseable JSON object');
            break;
          }
          if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            flag(d, 'json-merge body must be a single JSON object (not an array or scalar)');
          } else if (typeof d.attrs.key === 'string' && !(d.attrs.key in obj)) {
            flag(d, `json-merge body has no "${d.attrs.key}" field to match on`);
          }
        }
        break;
      }
      case 'prompt': {
        if (!promptVar(d)) flag(d, 'prompt requires a variable name, e.g. `nc:prompt token`');
        if (d.body.length === 0) flag(d, 'prompt requires a question in its body');
        const flags = typeof d.attrs.flags === 'string' ? d.attrs.flags : undefined;
        if (typeof d.attrs.validate === 'string') {
          try {
            new RegExp(d.attrs.validate, flags);
          } catch {
            flag(d, `prompt validate:${d.attrs.validate}${flags ? ` flags:${flags}` : ''} is not a valid regex`);
          }
        } else if (flags !== undefined) {
          // flags without validate: still verify they're legal regex flags.
          try {
            new RegExp('', flags);
          } catch {
            flag(d, `prompt flags:${flags} are not valid regex flags`);
          }
        }
        // Removed presentation attrs — reject loudly (they would silently no-op).
        if (d.attrs.min !== undefined) {
          flag(d, 'prompt min: was removed — encode the length in validate:, e.g. min:20 → validate:^.{20,}$');
        }
        if (d.attrs.error !== undefined) {
          flag(d, 'prompt error: was removed — the validation-miss message derives from the question prose');
        }
        if (typeof d.attrs.normalize === 'string' && !['trim', 'rstrip-slash', 'lower'].includes(d.attrs.normalize)) {
          flag(d, `prompt normalize:${d.attrs.normalize} must be one of trim|rstrip-slash|lower`);
        }
        if (typeof d.attrs.reuse === 'string' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.attrs.reuse)) {
          flag(d, `prompt reuse:${d.attrs.reuse} must be a valid ENV_KEY`);
        }
        break;
      }
      case 'operator':
        if (d.body.length === 0) flag(d, 'operator requires instructions for the human in its body');
        // Removed presentation attrs — reject loudly (they would silently no-op).
        if (d.attrs.open !== undefined) {
          flag(d, 'operator open: was removed — put the URL in the body prose (a consumer offers to open it)');
        }
        if (d.args.includes('gate') || d.attrs.gate !== undefined) {
          flag(d, 'operator gate was removed — the human barrier is derived from document structure, never authored');
        }
        break;
    }
    // Removed on every directive: label: (labels are heading-derived only) and
    // on-fail: (the failure hint is always the surrounding prose).
    if (d.attrs.label !== undefined) {
      flag(d, 'label: was removed — step labels derive from the preceding heading');
    }
    if (d.attrs['on-fail'] !== undefined) {
      flag(d, 'on-fail: was removed — the failure hint is always the surrounding prose');
    }
    // A consumer can only reference a variable an earlier prompt captured, or an
    // earlier `run capture:<var>` bound from a command's output.
    for (const ref of referencedVars(d)) {
      if (!defined.has(ref)) flag(d, `references {{${ref}}} but no earlier nc:prompt or nc:run capture defined it`);
    }
    // A `when:<var>=<value>` guard references an earlier-defined var by bare name.
    if (typeof d.attrs.when === 'string') {
      const eq = d.attrs.when.indexOf('=');
      if (eq < 1) {
        flag(d, `when:${d.attrs.when} must be <var>=<value>`);
      } else {
        const wvar = d.attrs.when.slice(0, eq).trim();
        if (!defined.has(wvar)) flag(d, `when:${d.attrs.when} references {{${wvar}}} but no earlier nc:prompt or nc:run capture defined it`);
      }
    }
    if (d.kind === 'prompt') {
      const v = promptVar(d);
      if (v) defined.add(v);
    }
    // capture:<var> binds stdout; capture:<var>=<FIELD>,… binds step block fields.
    if (d.kind === 'run' && typeof d.attrs.capture === 'string') {
      for (const v of captureVars(d.attrs.capture)) defined.add(v);
    }
    // A run's capture validate:<re> (the stdout shape-guard) must be a valid regex.
    if (d.kind === 'run' && typeof d.attrs.validate === 'string') {
      try {
        new RegExp(d.attrs.validate);
      } catch {
        flag(d, `run validate:${d.attrs.validate} is not a valid regex`);
      }
    }
  }
  return problems;
}

/**
 * A WARN-ONLY reference-floor check — never an error, never blocks a build. A
 * credentialed or interactive skill (one that prompts for a `secret`, or runs an
 * `nc:run effect:step` — a pairing code, a QR device-link) should ship a
 * `## Troubleshooting` section: the human floor a reader scrolls to when the live
 * step misbehaves. Missing it is a smell, not a failure — the skill still applies
 * cleanly — so this returns a warning the CLI prints but never exits non-zero on,
 * keeping it strictly advisory. Returns [] when no secret/step is present (no
 * floor is expected) or a `## Troubleshooting` heading already exists.
 */
export function lintReferenceFloor(markdown: string): Problem[] {
  const directives = parseDirectives(markdown);
  const isFloorBearing = (d: Directive): boolean =>
    (d.kind === 'prompt' && d.args.includes('secret')) || (d.kind === 'run' && d.attrs.effect === 'step');
  const anchor = directives.find(isFloorBearing);
  if (!anchor) return []; // no credential / interactive step ⇒ no floor expected
  const hasTroubleshooting = markdown.split('\n').some((l) => /^##\s+Troubleshooting\s*$/.test(l.trim()));
  if (hasTroubleshooting) return [];
  return [{
    line: anchor.line,
    kind: 'reference-floor',
    message: 'a credentialed/interactive skill should carry a ## Troubleshooting section (the human floor when a live step misbehaves)',
  }];
}

/**
 * A WARN-ONLY gate-ambiguity check — never an error, never blocks a build. The
 * driver's natural-barrier policy (scripts/skill-policy.ts) keys an operator's
 * pause decision off the next guard-compatible directive; an UNGUARDED operator
 * treats every following directive as compatible, so when the directives
 * immediately after it are `when:`-guarded and span more than one branch value,
 * the static decision keys off a directive that may be runtime-skipped (e.g.
 * unguarded operator → `prompt when:mode=remote` → `run when:mode=local`:
 * policy says no-confirm, but at runtime mode=local skips the prompt). No
 * in-tree skill authors this; warn so new authorship guards the operator (or
 * restructures) instead of getting a silently wrong barrier. The scan stops at
 * the first unguarded directive — that one always runs, so no ambiguity past it.
 */
export function lintGateAmbiguity(directives: Directive[]): Problem[] {
  const problems: Problem[] = [];
  for (let i = 0; i < directives.length; i++) {
    const d = directives[i];
    if (d.kind !== 'operator' || typeof d.attrs.when === 'string') continue;
    const branches = new Set<string>();
    for (let j = i + 1; j < directives.length; j++) {
      const g = directives[j].attrs.when;
      if (typeof g !== 'string') break;
      branches.add(g);
    }
    if (branches.size > 1) {
      problems.push({
        line: d.line,
        kind: 'gate-ambiguity',
        message: `unguarded nc:operator followed by when:-guarded directives spanning ${branches.size} branch values (${[...branches].join(', ')}) — the barrier decision may key off a runtime-skipped directive; guard the operator or restructure`,
      });
    }
  }
  return problems;
}

// CLI
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let path = process.argv[2];
  if (!path) {
    console.error('usage: pnpm exec tsx scripts/skill-directives.ts <skillDir|SKILL.md>');
    process.exit(2);
  }
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, 'SKILL.md');
  const md = readFileSync(path, 'utf8');
  const directives = parseDirectives(md);
  const problems = validate(directives, { chatVersion: resolveChatCoreVersion(process.cwd()) });
  // Warnings (gate ambiguity, reference floor) are advisory only — printed for
  // the author, never folded into the exit code (a smell, not a gate). Exit
  // stays driven solely by `validate` problems.
  const warnings = [...lintGateAmbiguity(directives), ...lintReferenceFloor(md)];
  for (const w of warnings) console.error(`warning: ${w.kind} (line ${w.line}): ${w.message}`);
  console.log(JSON.stringify({ directives, problems, warnings }, null, 2));
  process.exit(problems.length ? 1 : 0);
}
