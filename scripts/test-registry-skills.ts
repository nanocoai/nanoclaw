#!/usr/bin/env tsx

// Applies one branch-backed add-* skill to a disposable checkout and runs only
// its build/test directives. `--all` is the local equivalent of the CI matrix.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
const REGISTRY_MENTION = /(?:from-branch:|origin\/|git fetch\s+\S+\s+)(channels|providers)(?![A-Za-z0-9._\/-])/g;
const REGISTRY_BRANCHES = new Set(['channels', 'providers']);
const STUBBED_EFFECTS = new Set(['check', 'external', 'fetch']);
const SKIPPED_EFFECTS = ['restart', 'wire'];

interface RegistrySkill {
  skill: string;
  branches: string[];
  bun: boolean;
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
  const result = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`command exited ${result.status}: ${cmd}`);
  }
  return result.stdout ?? '';
}

function discover(): RegistrySkill[] {
  return readdirSync(SKILLS_ROOT)
    .filter((name) => name.startsWith('add-'))
    .flatMap((skill) => {
      const dir = join(SKILLS_ROOT, skill);
      const path = join(dir, 'SKILL.md');
      if (!existsSync(path)) return [];
      const markdown = readFileSync(path, 'utf8');
      if (![...markdown.matchAll(REGISTRY_MENTION)].length) return [];
      const directives = parseDirectives(markdown);
      const branches = [
        ...new Set(
          directives
            .filter((d) => d.kind === 'copy' && typeof d.attrs['from-branch'] === 'string')
            .map((d) => String(d.attrs['from-branch'])),
        ),
      ].sort();
      if (branches.some((branch) => !REGISTRY_BRANCHES.has(branch))) return [];
      return [
        {
          skill,
          branches,
          bun: markdown.includes('container/agent-runner'),
          executable: branches.length > 0,
          dir,
          markdown,
        },
      ];
    })
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

function fixtureScenarios(meta: RegistrySkill): FixtureScenario[] {
  const path = join(meta.dir, 'apply-fixtures.json');
  if (!existsSync(path)) return [{}];
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  return fixture.scenarios?.length ? fixture.scenarios : [{}];
}

function resolveRegistryRefs(): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const branch of REGISTRY_BRANCHES) {
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

function pinRegistryRef(root: string, branch: string, commit: string): void {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`], root);
  } catch {
    git(['fetch', 'origin', commit], root);
  }
  git(['update-ref', `refs/remotes/skill-ci/${branch}`, commit], root);
}

async function testSkill(
  meta: RegistrySkill,
  fixture: FixtureScenario,
  root: string,
  refs: Record<string, string>,
): Promise<void> {
  if (!meta.executable) {
    throw new Error(`${meta.skill} pulls registry code but has no nc:copy from-branch directive`);
  }

  const directives = parseDirectives(meta.markdown);
  const problems = [
    ...validate(directives, { chatVersion: resolveChatCoreVersion(root) }),
    ...lintGateAmbiguity(directives),
    ...lintReferenceFloor(meta.markdown),
  ];
  if (problems.length) throw new Error(problems.map((p) => `line ${p.line}: ${p.message}`).join('\n'));

  for (const branch of meta.branches) pinRegistryRef(root, branch, refs[branch]);
  const byLine = new Map(directives.map((directive) => [directive.line, directive]));
  let current = directives[0];

  const result = await applySkill(meta.dir, root, {
    inputs: fixture.inputs ?? {},
    skipEffects: SKIPPED_EFFECTS,
    resolveRemote: () => 'skill-ci',
    onEvent: (event) => {
      if (event.type === 'step-start') current = byLine.get(event.line);
    },
    exec: (cmd) => {
      if (/^git fetch skill-ci (channels|providers)$/.test(cmd)) return '';
      const stub = fixture.exec?.find((candidate) => cmd.includes(candidate.match));
      if (stub) return stub.stdout;
      if (current?.kind === 'run' && STUBBED_EFFECTS.has(String(current.attrs.effect))) {
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
}

async function testAll(skills: RegistrySkill[]): Promise<void> {
  const refs = resolveRegistryRefs();
  const head = git(['rev-parse', 'HEAD']);
  const failures: string[] = [];

  for (const meta of skills) {
    console.log(`\n==> ${meta.skill}`);
    if (!meta.executable) {
      failures.push(`${meta.skill}: no nc:copy from-branch directive`);
      console.error(`  FAIL: ${failures.at(-1)}`);
      continue;
    }

    const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-skill-ci-'));
    const root = join(temp, 'repo');
    try {
      git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
      git(['checkout', '--quiet', '--detach', head], root);
      command('pnpm install --frozen-lockfile --prefer-offline', root);
      if (meta.bun) command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));
      const scenarios = fixtureScenarios(meta);
      for (const [index, fixture] of scenarios.entries()) {
        const scenario = fixture.name ?? String(index + 1);
        if (scenarios.length > 1) console.log(`  scenario: ${scenario}`);
        try {
          await testSkill(meta, fixture, root, refs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`${scenario}: ${message}`);
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
  console.log(`\n${skills.length}/${skills.length} registry skills passed.`);
}

const skills = discover();
const arg = process.argv[2];

if (arg === '--list') {
  console.log(JSON.stringify(skills.map(({ skill, bun, executable }) => ({ skill, bun, executable }))));
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
  console.error('usage: pnpm exec tsx scripts/test-registry-skills.ts --list|--all [skill...]|<skill>');
  process.exitCode = 2;
}
