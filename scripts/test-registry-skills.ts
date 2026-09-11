#!/usr/bin/env tsx

// Applies one branch-backed add-* skill to a disposable checkout and runs only
// its build/test directives. `--all` is the local equivalent of the CI matrix.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { applySkill, fullyApplied, removeSkill } from './skill-apply.js';
import {
  lintGateAmbiguity,
  lintReferenceFloor,
  parseDirectives,
  resolveChatCoreVersion,
  validate,
} from './skill-directives.js';
import { refreshInstalledSkills, resolveRegistryRemote } from './update-skills.js';
import { verifyProviderContracts } from './provider-contract-verifier.js';
import { parseProviderDescriptor } from '../setup/providers/skill-descriptor.js';

const SOURCE_ROOT = process.cwd();
const SKILLS_ROOT = join(SOURCE_ROOT, '.claude/skills');
const REGISTRY_MENTION = /(?:from-branch:|origin\/|git fetch\s+\S+\s+)(channels|providers)(?![A-Za-z0-9._\/-])/g;
const REGISTRY_BRANCHES = new Set(['channels', 'providers']);
const STUBBED_EFFECTS = new Set(['check', 'external', 'fetch']);
const SKIPPED_EFFECTS = ['restart', 'wire'];
const LEGACY_PROVIDER_SKILLS = ['add-codex', 'add-opencode'];
const PRE_CONTRACT_CORE_SHA = '99283f3e274b2b1dae47b141ac4f11f56ad8eb2d';
// Immediate parent of the first providers-branch contract payload commit.
const PRE_CONTRACT_PROVIDERS_SHA = 'f503f23ce3da61048a8725716397e68ea0c22a30';

export interface RegistrySkill {
  skill: string;
  branches: string[];
  provider?: string;
  bun: boolean;
  executable: boolean;
  dir: string;
  markdown: string;
}

/** `true` when `<branch>:<path>` exists on the resolved registry commit. */
export type RegistrySourceCheck = (branch: string, path: string) => boolean;

export interface UnavailableRegistrySkill {
  skill: RegistrySkill;
  /** `<branch>:<path>` for every copy source the registry commit lacks. */
  missing: string[];
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

function ensureCommit(commit: string): void {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
  } catch {
    git(['fetch', 'origin', commit]);
  }
}

function snapshot(root: string): Map<string, string> {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .sort();
  return new Map(
    files.map((file) => {
      const full = join(root, file);
      if (!existsSync(full)) return [file, 'missing'];
      const stat = lstatSync(full);
      const content = stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full);
      const hash = createHash('sha256').update(content).digest('hex');
      return [file, `${stat.mode & 0o777}:${hash}`];
    }),
  );
}

function assertSnapshot(label: string, expected: Map<string, string>, actual: Map<string, string>): void {
  const changed = [...new Set([...expected.keys(), ...actual.keys()])].filter(
    (file) => expected.get(file) !== actual.get(file),
  );
  if (changed.length) throw new Error(`${label}: ${changed.slice(0, 20).join(', ')}`);
}

function materializeSkill(commit: string, skill: string, skillsRoot: string): RegistrySkill {
  ensureCommit(commit);
  const prefix = `.claude/skills/${skill}/`;
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit, '--', prefix], {
    cwd: SOURCE_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  if (!files.length) throw new Error(`${commit} has no ${skill} skill`);
  for (const file of files) {
    const dest = join(skillsRoot, file.slice('.claude/skills/'.length));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, execFileSync('git', ['show', `${commit}:${file}`], { cwd: SOURCE_ROOT }));
  }
  const meta = discover(skillsRoot).find((candidate) => candidate.skill === skill);
  if (!meta) throw new Error(`could not materialize ${skill} from ${commit}`);
  return meta;
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

function discover(skillsRoot = SKILLS_ROOT): RegistrySkill[] {
  return readdirSync(skillsRoot)
    .filter((name) => name.startsWith('add-'))
    .flatMap((skill) => {
      const dir = join(skillsRoot, skill);
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
          provider: parseProviderDescriptor(markdown, skill)?.value,
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

function hasRegistrySource(refs: Record<string, string>, branch: string, path: string): boolean {
  return (
    spawnSync('git', ['cat-file', '-e', `${refs[branch]}:${path}`], {
      cwd: SOURCE_ROOT,
      stdio: 'ignore',
    }).status === 0
  );
}

/** Every `nc:copy from-branch:` source of the skill that the registry commit does not carry. */
export function missingRegistrySources(meta: RegistrySkill, hasSource: RegistrySourceCheck): string[] {
  const missing: string[] = [];
  for (const directive of parseDirectives(meta.markdown)) {
    if (directive.kind !== 'copy' || typeof directive.attrs['from-branch'] !== 'string') continue;
    const branch = directive.attrs['from-branch'];
    for (const line of directive.body) {
      const source = line.includes('->') ? line.split('->')[0].trim() : line.trim();
      if (!hasSource(branch, source)) missing.push(`${branch}:${source}`);
    }
  }
  return missing;
}

/**
 * Split skills by whether the registry commit carries every file they copy.
 * A skill whose payload has not been promoted yet cannot be applied, so the
 * matrix skips it — but never silently: callers print `warnUnavailable`.
 */
export function partitionRegistryAvailability(
  skills: RegistrySkill[],
  hasSource: RegistrySourceCheck,
): { available: RegistrySkill[]; unavailable: UnavailableRegistrySkill[] } {
  const available: RegistrySkill[] = [];
  const unavailable: UnavailableRegistrySkill[] = [];
  for (const skill of skills) {
    const missing = missingRegistrySources(skill, hasSource);
    if (missing.length) unavailable.push({ skill, missing });
    else available.push(skill);
  }
  return { available, unavailable };
}

export function formatUnavailable({ skill, missing }: UnavailableRegistrySkill): string {
  return `WARN: ${skill.skill} unavailable in registry (missing: ${missing.join(', ')})`;
}

function warnUnavailable(unavailable: UnavailableRegistrySkill[]): void {
  for (const entry of unavailable) console.error(formatUnavailable(entry));
}

function registrySourceCheck(refs: Record<string, string>): RegistrySourceCheck {
  return (branch, path) => hasRegistrySource(refs, branch, path);
}

/**
 * The provider skills `--combined-providers` must exercise. Trunk carrying
 * provider skills whose payload is missing from the registry is a broken
 * composition (`/add-<name>` would fail at its copy step), so "none available"
 * is a failure — never a green "nothing to combine".
 */
export function selectCombinedProviders(
  skills: RegistrySkill[],
  hasSource: RegistrySourceCheck,
): Array<RegistrySkill & { provider: string }> {
  const providerSkills = skills.filter((skill) => skill.provider || skill.branches.includes('providers'));
  const missingMetadata = providerSkills.filter((skill) => !skill.provider);
  if (missingMetadata.length) {
    throw new Error(`provider skills missing nanoclaw-provider metadata: ${missingMetadata.map(({ skill }) => skill)}`);
  }
  const { available, unavailable } = partitionRegistryAvailability(providerSkills, hasSource);
  warnUnavailable(unavailable);
  if (providerSkills.length && !available.length) {
    throw new Error(
      `FAIL: trunk carries provider skills (${providerSkills.map(({ skill }) => skill).join(', ')}) ` +
        `but none is available in the providers registry:\n` +
        unavailable.map((entry) => `  ${formatUnavailable(entry)}`).join('\n') +
        `\nPromote the provider payloads to the providers branch (or pin REGISTRY_PROVIDERS_SHA to a commit that carries them) before this core lands.`,
    );
  }
  return available as Array<RegistrySkill & { provider: string }>;
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
  roundTrip: boolean,
  skipEffects = SKIPPED_EFFECTS,
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

  const apply = () =>
    applySkill(meta.dir, root, {
      inputs: fixture.inputs ?? {},
      skipEffects,
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

  const before = roundTrip && meta.branches.includes('providers') ? snapshot(root) : undefined;
  const result = await apply();

  if (!fullyApplied(result)) {
    const failures = [
      ...result.deferred.map((value) => `deferred: ${value}`),
      ...result.agentTasks.map((task) => `line ${task.line}: ${task.reason}`),
    ];
    throw new Error(failures.join('\n'));
  }
  if (roundTrip) {
    const installed = before ? snapshot(root) : undefined;
    await removeSkill(root, result.journal, (cmd) => command(cmd, root));
    if (before && installed) {
      assertSnapshot('provider removal did not restore the exact checkout', before, snapshot(root));
      const verification = await verifyProviderContracts(root, { exec: (cmd, cwd) => command(cmd, cwd) });
      if (verification.status !== 'passed') {
        throw new Error(`removed-state provider verification failed: ${verification.error ?? verification.status}`);
      }
      assertSnapshot('removed-state verification changed the checkout', before, snapshot(root));
    }
    const reapplied = await apply();
    if (!fullyApplied(reapplied)) throw new Error('provider add → remove → add round trip failed');
    if (installed)
      assertSnapshot('provider reapply did not restore the exact installed checkout', installed, snapshot(root));
  }
}

async function testCombinedProviders(skills: RegistrySkill[]): Promise<void> {
  const refs = resolveRegistryRefs();
  const selected = selectCombinedProviders(skills, registrySourceCheck(refs));
  if (!selected.length) {
    // Only reachable when trunk ships no provider skill at all.
    console.log('\nPASS: trunk carries no provider skills to combine');
    return;
  }
  const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-provider-ci-'));
  const root = join(temp, 'repo');
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
    git(['checkout', '--quiet', '--detach', git(['rev-parse', 'HEAD'])], root);
    command('pnpm install --frozen-lockfile --prefer-offline', root);
    command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    for (const meta of selected) {
      console.log(`\n==> ${meta.skill}`);
      await testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, refs, false, [...SKIPPED_EFFECTS, 'build', 'test']);
    }

    git(['update-ref', 'refs/heads/providers', refs.providers], root);
    git(['remote', 'remove', 'origin'], root);
    git(['remote', 'add', 'skill-ci', '.'], root);
    const report = await refreshInstalledSkills(root, 'all', {
      exec: (cmd, cwd) => command(cmd, cwd),
    });
    const expected = selected.map(({ provider }) => provider).sort();
    if (JSON.stringify(report.selected) !== JSON.stringify(expected)) {
      throw new Error(`update-skills detected ${report.selected.join(', ') || 'no providers'}`);
    }
    if (!report.success) {
      throw new Error(`update-skills refresh failed: ${JSON.stringify(report)}`);
    }
    const verification = await verifyProviderContracts(root, {
      // OpenCode retains its existing payload until its contract skill lands.
      // Every other installed provider must already declare its contract.
      expectedLegacyProviders: ['opencode'],
      exec: (cmd, cwd) => command(cmd, cwd),
    });
    if (verification.status !== 'passed') {
      throw new Error(`combined provider conformance failed: ${JSON.stringify(verification)}`);
    }
    console.log('\nPASS: combined providers install, refresh, and conformance');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testOldProviderRefresh(commit: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('old trunk must be a full commit SHA');

  ensureCommit(commit);
  const currentRefs = resolveRegistryRefs();
  ensureCommit(PRE_CONTRACT_PROVIDERS_SHA);
  const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-old-provider-refresh-ci-'));
  const root = join(temp, 'repo');
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
    git(['fetch', '--quiet', 'origin', commit], root);
    git(['checkout', '--quiet', '--detach', commit], root);
    command('pnpm install --frozen-lockfile --prefer-offline', root);
    command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    const oldSkills = LEGACY_PROVIDER_SKILLS.map((name) =>
      discover(join(root, '.claude/skills')).find(({ skill }) => skill === name),
    );
    if (oldSkills.some((skill) => !skill)) throw new Error('old trunk is missing a provider skill');

    const legacyRefs = { providers: PRE_CONTRACT_PROVIDERS_SHA };
    for (const meta of oldSkills as RegistrySkill[]) {
      console.log(`\n==> install ${meta.skill} from ${PRE_CONTRACT_PROVIDERS_SHA}`);
      await testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, legacyRefs, false, [
        ...SKIPPED_EFFECTS,
        'build',
        'test',
      ]);
    }

    git(['fetch', '--quiet', 'origin', currentRefs.providers], root);
    git(['update-ref', 'refs/heads/providers', currentRefs.providers], root);
    git(['remote', 'remove', 'origin'], root);
    git(['remote', 'add', 'skill-ci', '.'], root);
    const report = await refreshInstalledSkills(root, 'all', {
      exec: (cmd, cwd) => command(cmd, cwd),
    });
    const expected = ['codex', 'opencode'];
    if (JSON.stringify(report.selected) !== JSON.stringify(expected) || !report.success) {
      throw new Error(`old-install provider refresh failed: ${JSON.stringify(report)}`);
    }
    if (!existsSync(join(root, 'src/opencode-cli-tools.test.ts'))) {
      throw new Error('OpenCode refresh lost src/opencode-cli-tools.test.ts');
    }

    for (const meta of oldSkills as RegistrySkill[]) {
      console.log(`\n==> validate refreshed ${meta.skill} with its old install checks`);
      await testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, currentRefs, false);
    }
    console.log(
      `\nPASS: providers installed from ${PRE_CONTRACT_PROVIDERS_SHA} and refreshed to ${currentRefs.providers} on ${commit}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function testPreContractProviders(): Promise<void> {
  ensureCommit(PRE_CONTRACT_PROVIDERS_SHA);
  const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-pre-contract-provider-ci-'));
  const root = join(temp, 'repo');
  const skillsRoot = join(temp, 'skills');
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
    git(['checkout', '--quiet', '--detach', git(['rev-parse', 'HEAD'])], root);
    command('pnpm install --frozen-lockfile --prefer-offline', root);
    command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    const refs = { providers: PRE_CONTRACT_PROVIDERS_SHA };
    for (const name of LEGACY_PROVIDER_SKILLS) {
      const meta = materializeSkill(PRE_CONTRACT_CORE_SHA, name, skillsRoot);
      console.log(`\n==> ${name} from pre-contract providers ${PRE_CONTRACT_PROVIDERS_SHA}`);
      await testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, refs, false, [...SKIPPED_EFFECTS, 'build', 'test']);
    }

    const verification = await verifyProviderContracts(root, {
      expectedLegacyProviders: ['codex', 'opencode'],
      exec: (cmd, cwd) => command(cmd, cwd),
    });
    if (verification.status !== 'passed') {
      throw new Error(`pre-contract provider verification failed: ${verification.error ?? verification.status}`);
    }
    console.log(`\nPASS: new core with pre-contract provider payloads ${PRE_CONTRACT_PROVIDERS_SHA}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
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
          await testSkill(meta, fixture, root, refs, index === 0 && meta.branches.includes('providers'));
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

async function main(): Promise<void> {
  const skills = discover();
  const arg = process.argv[2];

  if (arg === '--list') {
    console.log(JSON.stringify(skills.map(({ skill, bun, executable }) => ({ skill, bun, executable }))));
  } else if (arg === '--list-available') {
    const refs = resolveRegistryRefs();
    const { available, unavailable } = partitionRegistryAvailability(skills, registrySourceCheck(refs));
    warnUnavailable(unavailable);
    console.log(JSON.stringify(available.map(({ skill, bun, executable }) => ({ skill, bun, executable }))));
  } else if (arg === '--all') {
    const requested = process.argv.slice(3);
    const selected = requested.length ? skills.filter(({ skill }) => requested.includes(skill)) : skills;
    if (selected.length !== (requested.length || skills.length))
      throw new Error('unknown registry skill in --all filter');
    await testAll(selected);
  } else if (arg === '--combined-providers') {
    await testCombinedProviders(skills);
  } else if (arg === '--old-provider-refresh') {
    await testOldProviderRefresh(process.argv[3] ?? '');
  } else if (arg === '--pre-contract-providers') {
    await testPreContractProviders();
  } else if (arg) {
    const meta = skills.find((candidate) => candidate.skill === basename(arg));
    if (!meta) throw new Error(`unknown registry skill: ${arg}`);
    await testAll([meta]);
  } else {
    console.error(
      'usage: pnpm exec tsx scripts/test-registry-skills.ts --list|--list-available|--all [skill...]|--combined-providers|--old-provider-refresh <sha>|--pre-contract-providers|<skill>',
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
