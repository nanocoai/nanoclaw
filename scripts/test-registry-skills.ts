#!/usr/bin/env tsx

// Applies one branch-backed add-* skill to a disposable checkout and runs only
// its build/test directives. `--all` is the local equivalent of the CI matrix.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { getSkillCompanions, materializeSkillCompanion, type SkillCompanion } from '../setup/skill-compositions.js';
import { validateSkill, validateSkillMarkdown } from '../src/templates/skills.js';
import { applySkill, fullyApplied } from './skill-apply.js';
import {
  lintGateAmbiguity,
  lintReferenceFloor,
  parseDirectives,
  resolveChatCoreVersion,
  validate,
} from './skill-directives.js';
import { resolveRegistryRemote } from './update-skills.js';

const SOURCE_ROOT = process.cwd();
const SKILLS_ROOT = join(SOURCE_ROOT, '.claude/skills');
const TEMP_ROOT = process.env.ACT ? SOURCE_ROOT : tmpdir();
const REGISTRY_MENTION = /(?:from-branch:|origin\/|git fetch\s+\S+\s+)(channels|providers)(?![A-Za-z0-9._\/-])/g;
const REGISTRY_BRANCHES = new Set(['channels', 'providers']);
const MUTATION_KINDS = new Set(['append', 'copy', 'dep', 'env-set', 'json-merge']);
const STUBBED_EFFECTS = new Set(['check', 'external', 'fetch']);
const COMPOSED_STUBBED_EFFECTS = new Set(['external', 'fetch']);
const SKIPPED_EFFECTS = ['restart', 'wire'];

interface RegistrySkill {
  skill: string;
  steps: SkillCompanion[];
  branches: string[];
  bun: boolean;
  image: boolean;
  executable: boolean;
  dir: string;
  markdown: string;
}

interface Fixture {
  scenarios?: Array<{
    name?: string;
    inputs?: Record<string, string>;
    exec?: Array<{ match: string; stdout: string }>;
    stepFields?: Record<string, string>;
  }>;
}

type FixtureScenario = NonNullable<Fixture['scenarios']>[number];

function git(args: string[], cwd = SOURCE_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function command(cmd: string, cwd: string, quiet = false): string {
  if (!quiet) console.log(`  $ ${cmd}`);
  const result = spawnSync(cmd, { cwd, shell: '/bin/bash', encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`command exited ${result.status}: ${cmd}`);
  }
  return result.stdout ?? '';
}

function discover(): RegistrySkill[] {
  const standalone = readdirSync(SKILLS_ROOT)
    .filter((name) => name.startsWith('add-'))
    .flatMap((skill) => {
      const dir = join(SKILLS_ROOT, skill);
      const path = join(dir, 'SKILL.md');
      if (!existsSync(path)) return [];
      const markdown = readFileSync(path, 'utf8');
      const directives = parseDirectives(markdown);
      const registryBacked = [...markdown.matchAll(REGISTRY_MENTION)].length > 0;
      const mutatesProject = directives.some(
        (directive) =>
          MUTATION_KINDS.has(directive.kind) || (directive.kind === 'run' && directive.attrs.effect === undefined),
      );
      if (!registryBacked && !mutatesProject) return [];
      const branches = [
        ...new Set(
          directives
            .filter((d) => d.kind === 'copy' && typeof d.attrs['from-branch'] === 'string')
            .map((d) => String(d.attrs['from-branch'])),
        ),
      ].sort();
      const unsupported = branches.find((branch) => !REGISTRY_BRANCHES.has(branch));
      if (unsupported) throw new Error(`${skill} uses unsupported registry branch ${unsupported}`);
      return [
        {
          skill,
          steps: [{ skill }],
          branches,
          bun: markdown.includes('container/agent-runner'),
          image: false,
          executable: !registryBacked || branches.length > 0,
          dir,
          markdown,
        },
      ];
    })
    .sort((a, b) => a.skill.localeCompare(b.skill));

  return standalone.flatMap((meta) => {
    const companions = getSkillCompanions(meta.skill);
    if (companions.length === 0) return [meta];
    const unsupported = companions.find(({ branch }) => branch && !REGISTRY_BRANCHES.has(branch));
    if (unsupported?.branch) {
      throw new Error(`${unsupported.skill} uses unsupported registry branch ${unsupported.branch}`);
    }
    return [
      meta,
      {
        ...meta,
        skill: [meta.skill, ...companions.map(({ skill }) => skill)].join('+'),
        steps: [{ skill: meta.skill }, ...companions],
        branches: [
          ...new Set([...meta.branches, ...companions.flatMap(({ branch }) => (branch ? [branch] : []))]),
        ].sort(),
        bun: true,
        image: true,
      },
    ];
  });
}

function fixtureScenarios(dir: string): FixtureScenario[] {
  const path = join(dir, 'apply-fixtures.json');
  if (!existsSync(path)) return [{}];
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  return fixture.scenarios?.length ? fixture.scenarios : [{}];
}

function resolveRegistryRefs(branches: Iterable<string> = REGISTRY_BRANCHES): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const branch of branches) {
    const remote = resolveRegistryRemote(SOURCE_ROOT, branch);
    const envName = `REGISTRY_${branch.toUpperCase()}_SHA`;
    const pinned = process.env[envName];
    if (pinned && !/^[0-9a-f]{40}$/i.test(pinned)) throw new Error(`${envName} must be a full commit SHA`);
    if (pinned) {
      try {
        git(['cat-file', '-e', `${pinned}^{commit}`]);
      } catch {
        git(['fetch', remote, pinned]);
      }
      refs[branch] = pinned;
    } else {
      git(['fetch', remote, branch]);
      refs[branch] = git(['rev-parse', 'FETCH_HEAD']);
    }
  }
  return refs;
}

function validateRegistrySkillDocs(refs: Record<string, string>): void {
  const failures: string[] = [];
  const activeSkills = new Set(
    readdirSync(SKILLS_ROOT).filter((name) => existsSync(join(SKILLS_ROOT, name, 'SKILL.md'))),
  );
  for (const name of [...activeSkills]) {
    getSkillCompanions(name).forEach(({ skill }) => activeSkills.add(skill));
  }
  let count = 0;
  let inactive = 0;
  for (const [branch, ref] of Object.entries(refs)) {
    const paths = git(['ls-tree', '-r', '--name-only', ref])
      .split('\n')
      .filter(
        (path) =>
          path.endsWith('/SKILL.md') && (path.startsWith('.claude/skills/') || path.startsWith('container/skills/')),
      );
    for (const path of paths) {
      const skill = path.startsWith('.claude/skills/') ? path.slice('.claude/skills/'.length).split('/')[0] : '';
      if (skill && !activeSkills.has(skill)) {
        inactive += 1;
        continue;
      }
      count += 1;
      const problem = validateSkillMarkdown(git(['show', `${ref}:${path}`]));
      if (problem) failures.push(`${branch}:${path}: ${problem}`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(
    `${count} active registry skill documents passed anatomy validation; ${inactive} inactive documents skipped.`,
  );
}

function pinRegistryRef(root: string, branch: string, commit: string): void {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`], root);
  } catch {
    git(['fetch', 'origin', commit], root);
  }
  git(['update-ref', `refs/remotes/skill-ci/${branch}`, commit], root);
}

function workspaceState(root: string): string {
  const paths = git(['ls-files', '--others', '--exclude-standard'], root).split('\n').filter(Boolean);
  if (existsSync(join(root, '.env'))) paths.push('.env');
  const hashes = [...new Set(paths)]
    .sort()
    .map((path) => `${path}:${git(['hash-object', path], root)}`)
    .join('\n');
  return `${git(['diff', '--binary', 'HEAD'], root)}\n${hashes}`;
}

async function testSkill(
  meta: RegistrySkill,
  dir: string,
  markdown: string,
  fixture: FixtureScenario,
  root: string,
  refs: Record<string, string>,
): Promise<void> {
  if (!meta.executable) {
    throw new Error(`${meta.skill} has no deterministic apply directive`);
  }

  const anatomy = validateSkill(dir);
  if (anatomy) throw new Error(anatomy);
  const directives = parseDirectives(markdown);
  if (directives.length === 0) throw new Error(`${basename(dir)} has no nc: directives`);
  const problems = [
    ...validate(directives, { chatVersion: resolveChatCoreVersion(root) }),
    ...lintGateAmbiguity(directives),
    ...lintReferenceFloor(markdown),
  ];
  if (problems.length) throw new Error(problems.map((p) => `line ${p.line}: ${p.message}`).join('\n'));

  for (const branch of meta.branches) pinRegistryRef(root, branch, refs[branch]);
  const byLine = new Map(directives.map((directive) => [directive.line, directive]));
  const repeatSkipEffects = [...SKIPPED_EFFECTS, 'build', 'test'];
  let firstState = '';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let current = directives[0];
    const result = await applySkill(dir, root, {
      inputs: fixture.inputs ?? {},
      skipEffects: attempt === 1 ? SKIPPED_EFFECTS : repeatSkipEffects,
      resolveRemote: () => 'skill-ci',
      onEvent: (event) => {
        if (event.type === 'step-start') current = byLine.get(event.line);
      },
      exec: (cmd) => {
        if (/^git fetch skill-ci (channels|providers)$/.test(cmd)) return '';
        const stub = fixture.exec?.find((candidate) => cmd.includes(candidate.match));
        if (stub) return stub.stdout;
        const stubbedEffects = meta.steps.length > 1 ? COMPOSED_STUBBED_EFFECTS : STUBBED_EFFECTS;
        if (current?.kind === 'run' && stubbedEffects.has(String(current.attrs.effect))) {
          return '';
        }
        return command(cmd, root);
      },
      execStream: async () => ({ ok: true, fields: fixture.stepFields ?? {} }),
    });

    if (!fullyApplied(result)) {
      const failures = [
        ...result.deferred.map((value) => `deferred: ${value}`),
        ...result.agentTasks.map((task) => `line ${task.line}: ${task.reason}`),
      ];
      throw new Error(failures.join('\n'));
    }

    const state = workspaceState(root);
    if (attempt === 1) firstState = state;
    else if (state !== firstState) throw new Error('second apply changed the composed project');
  }
}

async function testAll(skills: RegistrySkill[]): Promise<void> {
  const refs = resolveRegistryRefs(new Set(skills.flatMap(({ branches }) => branches)));
  const head = git(['rev-parse', 'HEAD']);
  const failures: string[] = [];

  for (const meta of skills) {
    console.log(`\n==> ${meta.skill}`);
    if (!meta.executable) {
      failures.push(`${meta.skill}: no deterministic apply directive`);
      console.error(`  FAIL: ${failures.at(-1)}`);
      continue;
    }

    const temp = mkdtempSync(join(TEMP_ROOT, '.nanoclaw-skill-ci-'));
    chmodSync(temp, 0o755);
    const root = join(temp, 'repo');
    try {
      git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
      git(['checkout', '--quiet', '--detach', head], root);
      command('pnpm install --frozen-lockfile --prefer-offline', root);
      if (meta.bun) command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));
      if (meta.image) command('./container/build.sh', root);

      for (const [index, step] of meta.steps.entries()) {
        const skill = step.skill;
        let dir = meta.dir;
        if (index > 0) {
          const ok = materializeSkillCompanion(step, root, {
            resolveRemote: () => 'skill-ci',
            exec: (cmd) => (/^git fetch skill-ci (channels|providers)$/.test(cmd) ? '' : command(cmd, root, true)),
          });
          if (!ok) throw new Error(`could not materialize companion skill ${skill}`);
          dir = join(root, '.claude/skills', skill);
        }
        const markdown = readFileSync(join(dir, 'SKILL.md'), 'utf8');
        const scenarios = fixtureScenarios(dir);
        for (const [scenarioIndex, fixture] of scenarios.entries()) {
          const scenario = fixture.name ?? String(scenarioIndex + 1);
          if (meta.steps.length > 1 || scenarios.length > 1) console.log(`  ${skill}: ${scenario}`);
          try {
            await testSkill(meta, dir, markdown, fixture, root, refs);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${scenario}: ${message}`);
          }
        }
      }
      console.log(`  PASS: ${meta.skill}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${meta.skill}: ${message}`);
      console.error(`  FAIL: ${message}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  if (failures.length) throw new Error(`\n${failures.length}/${skills.length} skills failed:\n${failures.join('\n')}`);
  console.log(`\n${skills.length}/${skills.length} skill compositions passed.`);
}

const skills = discover();
const arg = process.argv[2];

if (arg === '--list') {
  console.log(JSON.stringify(skills.map(({ skill, bun, executable }) => ({ skill, bun, executable }))));
} else if (arg === '--validate-docs') {
  validateRegistrySkillDocs(resolveRegistryRefs());
} else if (arg === '--all') {
  const requested = process.argv.slice(3);
  const selected = requested.length ? skills.filter(({ skill }) => requested.includes(skill)) : skills;
  if (selected.length !== (requested.length || skills.length))
    throw new Error('unknown registry skill in --all filter');
  await testAll(selected);
} else if (arg) {
  const meta = skills.find((candidate) => candidate.skill === basename(arg));
  if (!meta) throw new Error(`unknown registry skill: ${arg}`);
  await testAll([meta]);
} else {
  console.error('usage: pnpm exec tsx scripts/test-registry-skills.ts --list|--validate-docs|--all [skill...]|<skill>');
  process.exitCode = 2;
}
