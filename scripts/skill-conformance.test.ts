// CI conformance for programmatic skill apply.
//
// Auto-discovers every .claude/skills/*/SKILL.md that carries nc: directive
// fences (discovery-based, not a hardcoded list — a new fence-carrying skill is
// covered the day it lands) and, per skill:
//
//   1. parse + validate + warn-lints all clean (errors AND advisory warnings —
//      in-tree skills must stay warning-free);
//   2. per branch-scenario from the colocated apply-fixtures.json, drives
//      applySkill end-to-end with stubbed exec/execStream/resolveRemote in a
//      scratch root and asserts a fully-programmatic green run: nothing
//      deferred, nothing bounced to an agent, balanced step events;
//   3. every when:-guard value is exercised by at least one scenario (checked
//      via ApplyResult.vars — guard vars are non-secret prompts/captures);
//   4. static effect-ordering invariants: code mutations → build → test, and
//      restart only after build+test. NOTE deliberately NOT "restart last" —
//      real skills restart BEFORE their pairing effect:step (the adapter must
//      be live to pair) and may write env after;
//   5. the dynamic run-health gate: a failure injected at the first
//      fetch/check/external run must block every later restart/step/wire
//      (bounced to an agent, never executed);
//   6. fixture hygiene: scenario input keys ⊆ the skill's prompt vars, every
//      unguarded prompt answered by every scenario, and a skill with prompts
//      MUST ship a fixture file (actionable failure otherwise).
//
// Everything is stubbed — no network, no git, no pnpm add — so this runs in
// milliseconds inside the normal vitest CI step.

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applySkill, fullyApplied, type ApplyEvent, type ApplyResult } from './skill-apply.js';
import {
  parseDirectives,
  validate,
  resolveChatCoreVersion,
  promptVar,
  lintGateAmbiguity,
  lintReferenceFloor,
  type Directive,
} from './skill-directives.js';

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, '.claude/skills');
const CHAT_VERSION = resolveChatCoreVersion(ROOT);

// ---------------------------------------------------------------------------
// Discovery: every skill whose SKILL.md opens an nc: fence.
// ---------------------------------------------------------------------------

const SKILLS = readdirSync(SKILLS_DIR).filter((n) => {
  const p = join(SKILLS_DIR, n, 'SKILL.md');
  return existsSync(p) && /^```nc:/m.test(readFileSync(p, 'utf8'));
});

// ---------------------------------------------------------------------------
// Fixtures: .claude/skills/<name>/apply-fixtures.json, colocated so a skill
// edit and its fixture update land in one diff. Prompt-less skills fall back
// to a single empty default scenario.
// ---------------------------------------------------------------------------

interface ExecStub {
  match: string; // substring of the (var-substituted) command
  stdout: string;
}
interface Scenario {
  name: string;
  inputs?: Record<string, string>;
  exec?: ExecStub[];
  stepFields?: Record<string, string>; // effect:step terminal-block fields
}
interface Fixture {
  notes?: string;
  coverageExclude?: string[]; // "var=value" guards final-vars coverage can't see
  coverageExcludeReason?: string;
  scenarios: Scenario[];
}

function loadFixture(name: string): Fixture | undefined {
  const p = join(SKILLS_DIR, name, 'apply-fixtures.json');
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf8')) as Fixture;
}

// ---------------------------------------------------------------------------
// Scratch project root: every append/env-set/json-merge target a trunk skill
// writes to must pre-exist (appendFileSync creates files but not directories,
// and marker appends need the dormant marker region).
// ---------------------------------------------------------------------------

const scratchRoots: string[] = [];
afterAll(() => {
  for (const r of scratchRoots) rmSync(r, { recursive: true, force: true });
});

function scratchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'skill-conformance-'));
  scratchRoots.push(root);
  mkdirSync(join(root, 'src/channels'), { recursive: true });
  mkdirSync(join(root, 'src/providers'), { recursive: true });
  mkdirSync(join(root, 'container/agent-runner/src/providers'), { recursive: true });
  mkdirSync(join(root, 'setup/providers'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}\n');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, 'src/channels/index.ts'), '// channel adapter barrel\n');
  writeFileSync(join(root, 'src/providers/index.ts'), '// provider barrel\n');
  writeFileSync(join(root, 'container/agent-runner/src/providers/index.ts'), '// container provider barrel\n');
  writeFileSync(join(root, 'setup/providers/index.ts'), '// setup provider barrel\n');
  writeFileSync(
    join(root, 'setup/index.ts'),
    ['const STEPS = {', '  // >>> nanoclaw:setup-steps', '  // <<< nanoclaw:setup-steps', '};', ''].join('\n'),
  );
  writeFileSync(join(root, 'container/cli-tools.json'), '[]\n');
  return root;
}

interface RunOutcome {
  res: ApplyResult;
  cmds: string[];
  streamed: string[];
  events: ApplyEvent[];
}

async function runScenario(skillDir: string, sc: Scenario): Promise<RunOutcome> {
  const root = scratchRoot();
  const cmds: string[] = [];
  const streamed: string[] = [];
  const events: ApplyEvent[] = [];
  const res = await applySkill(skillDir, root, {
    inputs: sc.inputs ?? {},
    // resolveRemote MUST be injected: the default shells out to real
    // `git remote` + `git ls-remote` — network in CI, nondeterministic on forks.
    resolveRemote: () => 'origin',
    exec: (c) => {
      cmds.push(c);
      return sc.exec?.find((e) => c.includes(e.match))?.stdout;
    },
    execStream: async (c) => {
      streamed.push(c);
      return { ok: true, fields: sc.stepFields ?? {} };
    },
    onEvent: (e) => void events.push(e),
  });
  return { res, cmds, streamed, events };
}

const isString = (x: unknown): x is string => typeof x === 'string';
const SIDE_EFFECTS = new Set(['restart', 'step', 'wire']);
const SABOTEUR_EFFECTS = new Set(['fetch', 'check', 'external']);
const isSideEffectRun = (d: Directive | undefined): boolean =>
  d?.kind === 'run' && isString(d.attrs.effect) && SIDE_EFFECTS.has(d.attrs.effect);

// ---------------------------------------------------------------------------

describe('skill discovery', () => {
  it('finds the fence-carrying skills', () => {
    // Sanity floor: discovery walking the wrong directory (or the fence regex
    // regressing) must fail loudly, not silently skip the whole suite.
    expect(SKILLS).toContain('add-slack');
    expect(SKILLS).toContain('add-whatsapp');
    expect(SKILLS.length).toBeGreaterThanOrEqual(10);
  });
});

describe.each(SKILLS)('%s', (name) => {
  const dir = join(SKILLS_DIR, name);
  const md = readFileSync(join(dir, 'SKILL.md'), 'utf8');
  const directives = parseDirectives(md);
  const byLine = new Map(directives.map((d) => [d.line, d]));
  const promptVars = new Set(
    directives.filter((d) => d.kind === 'prompt').map((d) => promptVar(d)).filter(isString),
  );
  const guards = [...new Set(directives.map((d) => d.attrs.when).filter(isString))];
  const fixture = loadFixture(name);
  const scenarios: Scenario[] = fixture?.scenarios ?? [{ name: 'default', inputs: {} }];

  it('parses + validates + warn-lints clean', () => {
    expect(validate(directives, { chatVersion: CHAT_VERSION })).toEqual([]);
    // Advisory warnings too: in-tree skills must stay warning-free.
    expect(lintGateAmbiguity(directives)).toEqual([]);
    expect(lintReferenceFloor(md)).toEqual([]);
  });

  it('fixture hygiene: prompts have a fixture, inputs match prompt vars, unguarded prompts always answered', () => {
    if (promptVars.size > 0) {
      expect(
        fixture,
        `${name} declares nc:prompt directives but has no apply-fixtures.json — add .claude/skills/${name}/apply-fixtures.json with a "scenarios" array: shaped fake inputs per prompt var (satisfying each validate: regex), exec stubs (substring match → stdout) for every capture run, and stepFields for any effect:step`,
      ).toBeDefined();
    }
    const unguarded = directives
      .filter((d) => d.kind === 'prompt' && !isString(d.attrs.when))
      .map((d) => promptVar(d))
      .filter(isString);
    for (const sc of fixture?.scenarios ?? []) {
      for (const k of Object.keys(sc.inputs ?? {})) {
        expect(promptVars.has(k), `scenario "${sc.name}" supplies input "${k}" which is not a prompt var of ${name} — stale fixture?`).toBe(true);
      }
      for (const v of unguarded) {
        expect(
          sc.inputs?.[v],
          `scenario "${sc.name}" is missing unguarded prompt var "${v}" — it would defer and the apply could never be fully programmatic`,
        ).toBeDefined();
      }
    }
    // coverageExclude entries must reference guards that actually exist.
    const guardSet = new Set(guards);
    for (const g of fixture?.coverageExclude ?? []) {
      expect(guardSet.has(g), `coverageExclude "${g}" is not a when:-guard of ${name} — stale exclusion?`).toBe(true);
    }
  });

  it.each(scenarios)('applies fully programmatically: $name', async (sc) => {
    const { res, events } = await runScenario(dir, sc);
    expect(res.agentTasks).toEqual([]); // nothing degraded to an agent
    expect(res.deferred).toEqual([]); // every prompt satisfied AND validate-at-bind passed
    expect(fullyApplied(res)).toBe(true);
    // Balanced step brackets, all green.
    const starts = events.filter((e) => e.type === 'step-start');
    const ends = events.filter((e): e is Extract<ApplyEvent, { type: 'step-end' }> => e.type === 'step-end');
    expect(starts.length).toBe(ends.length);
    expect(ends.every((e) => e.ok)).toBe(true);
    // Every resolved non-secret var is non-empty — an empty capture means an
    // exec/stepFields fixture entry is missing (bindCapture binds '' when the
    // stub returned nothing and no validate: catches it).
    for (const [k, v] of Object.entries(res.vars)) {
      expect(v, `resolved {{${k}}} is empty in scenario "${sc.name}" — add/fix the exec or stepFields fixture entry answering that capture`).not.toBe('');
    }
  });

  it('covers every when:-guard value across scenarios', async () => {
    if (guards.length === 0) return;
    const excluded = new Set(fixture?.coverageExclude ?? []);
    const results: ApplyResult[] = [];
    for (const sc of scenarios) results.push((await runScenario(dir, sc)).res);
    for (const g of guards) {
      if (excluded.has(g)) continue;
      const eq = g.indexOf('=');
      const [v, val] = [g.slice(0, eq), g.slice(eq + 1)];
      expect(
        results.some((r) => r.vars[v] === val),
        `no scenario exercises when:${g} in ${name} — add a scenario to apply-fixtures.json (or coverageExclude it with a reason)`,
      ).toBe(true);
    }
  });

  // Static, document-order invariants. Deliberately NOT "restart last":
  // telegram/whatsapp/signal restart BEFORE their pairing effect:step (the
  // adapter must be live to pair) and whatsapp writes env after the restart.
  // What DOES hold: code mutations land before the build, the build runs
  // before the tests, and a restart never precedes the build or the tests
  // that validate what it would load.
  it('effect ordering: mutations → build → test; restart only after build+test', () => {
    const firstBuild = directives.findIndex((d) => d.kind === 'run' && d.attrs.effect === 'build');
    const firstTest = directives.findIndex((d) => d.kind === 'run' && d.attrs.effect === 'test');
    if (firstBuild >= 0 && firstTest >= 0) expect(firstBuild).toBeLessThan(firstTest);
    if (firstBuild >= 0) {
      directives.forEach((d, i) => {
        if (['copy', 'append', 'dep', 'json-merge'].includes(d.kind)) {
          expect(i, `${d.kind} at line ${d.line} lands after the build — the build would not see it`).toBeLessThan(firstBuild);
        }
      });
    }
    directives.forEach((d, i) => {
      if (d.kind === 'run' && d.attrs.effect === 'restart') {
        if (firstBuild >= 0) expect(i, `restart at line ${d.line} precedes the build`).toBeGreaterThan(firstBuild);
        if (firstTest >= 0) expect(i, `restart at line ${d.line} precedes the tests`).toBeGreaterThan(firstTest);
      }
    });
  });

  // A restart-shaped command on a bare `nc:run` (no effect:) would silently
  // escape both skipEffects ownership and the run-health gate.
  it('no restart-shaped command hides on a bare nc:run', () => {
    for (const d of directives) {
      if (d.kind !== 'run' || d.attrs.effect !== undefined) continue;
      for (const cmd of d.body) {
        expect(
          /restart\.sh|kickstart|systemctl/.test(cmd),
          `bare nc:run at line ${d.line} runs a restart-shaped command ("${cmd}") without effect:restart — it would evade the run-health gate`,
        ).toBe(false);
      }
    }
  });

  // Dynamic twin of the engine's run-health-gate unit tests, per real skill:
  // inject a failure at the first fetch/check/external run a scenario reaches
  // and assert no restart/step/wire executes afterwards — authoring that
  // evades the gate (or a gate regression against real documents) fails here.
  it('run-health gate: a failed fetch/check/external blocks every later restart/step/wire', async () => {
    for (const sc of scenarios) {
      let current: Directive | undefined;
      let sabotagedLine = -1;
      let streamedAfterSabotage = 0;
      const sideEffectStartsAfterSabotage: number[] = [];
      const root = scratchRoot();
      const res = await applySkill(dir, root, {
        inputs: sc.inputs ?? {},
        resolveRemote: () => 'origin',
        onEvent: (e) => {
          if (e.type !== 'step-start') return;
          current = byLine.get(e.line);
          if (sabotagedLine >= 0 && isSideEffectRun(current)) sideEffectStartsAfterSabotage.push(e.line);
        },
        exec: (c) => {
          if (
            sabotagedLine < 0 &&
            current?.kind === 'run' &&
            isString(current.attrs.effect) &&
            SABOTEUR_EFFECTS.has(current.attrs.effect)
          ) {
            sabotagedLine = current.line;
            throw new Error('conformance sabotage');
          }
          return sc.exec?.find((e) => c.includes(e.match))?.stdout;
        },
        execStream: async () => {
          if (sabotagedLine >= 0) streamedAfterSabotage++;
          return { ok: true, fields: sc.stepFields ?? {} };
        },
      });
      if (sabotagedLine < 0) continue; // this scenario never reaches a saboteur-eligible run
      // The sabotaged run itself bounced to an agent…
      expect(fullyApplied(res)).toBe(false);
      expect(res.agentTasks.some((t) => t.line === sabotagedLine)).toBe(true);
      // …and no dangerous side effect fired on its own afterwards.
      expect(sideEffectStartsAfterSabotage).toEqual([]);
      expect(streamedAfterSabotage).toBe(0);
      // Any unguarded later side effect must surface as a gated agentTask, so
      // an agent finishes it from the prose once the failure is fixed.
      const gatedExpected = directives.some(
        (d) => isSideEffectRun(d) && !isString(d.attrs.when) && d.line > sabotagedLine,
      );
      if (gatedExpected) {
        expect(res.agentTasks.some((t) => /earlier step did not complete/.test(t.reason))).toBe(true);
      }
      return; // one sabotaged scenario per skill is enough
    }
  });
});
