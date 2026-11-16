#!/usr/bin/env tsx

// Applies one branch-backed or self-contained provider or channel add-* skill to a disposable checkout and
// runs only its build/test directives. `--all` is the local equivalent of the CI matrix.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
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
import { gitFetchBranchCommand } from './git-fetch-branch.js';
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

// Build on the Slack adapter's files, so only the combined-channels tree can test them, never the per-skill matrix.
const CHANNEL_COMPANION_SKILLS = new Set(['slack-a2a-rooms', 'slack-agent-flow']);
// The four adapters most v2026.10.0 hosts carry, all installed from the channels branch.
const OLD_CHANNEL_SKILLS = ['add-gchat', 'add-slack', 'add-telegram', 'add-whatsapp'];

export interface RegistrySkill {
  skill: string;
  branches: string[];
  provider?: string;
  /** A copy writes under src/channels/: the skill installs a channel adapter. */
  channel: boolean;
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
  return new Map(files.map((file) => [file, fileState(root, file)]));
}

function fileState(root: string, file: string): string {
  const full = join(root, file);
  if (!existsSync(full)) return 'missing';
  const stat = lstatSync(full);
  const content = stat.isSymbolicLink() ? readlinkSync(full) : readFileSync(full);
  const hash = createHash('sha256').update(content).digest('hex');
  return `${stat.mode & 0o777}:${hash}`;
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

// Streams as it runs so a hung step shows where it stopped; the job-level
// timeout bounds it. stdout is also captured for the caller.
function command(cmd: string, cwd: string, quiet = false): Promise<string> {
  if (!quiet) console.log(`  $ ${cmd}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.on('error', (error) => reject(new Error(`command failed: ${error.message}: ${cmd}`)));
    child.on('close', (status, signal) => {
      if (status === 0) return resolve(Buffer.concat(stdout).toString('utf8'));
      reject(new Error(`command ${signal ? `killed by ${signal}` : `exited ${status}`}: ${cmd}`));
    });
  });
}

/**
 * Each unguarded copy with its source: a registry branch path, or a file in the skill
 * directory. A `when:` copy hangs on answers or captured values the harness does not reproduce.
 */
export function copySources(meta: RegistrySkill): Array<{ dest: string; branch?: string; source: string }> {
  return parseDirectives(meta.markdown)
    .filter((directive) => directive.kind === 'copy' && !directive.attrs.when)
    .flatMap((directive) =>
      directive.body.map((line) => {
        const [source, dest = source] = line.split('->').map((part) => part.trim());
        const branch = directive.attrs['from-branch'];
        return typeof branch === 'string' ? { dest, branch, source } : { dest, source };
      }),
    );
}

export function discover(skillsRoot = SKILLS_ROOT, warn?: (message: string) => void): RegistrySkill[] {
  return readdirSync(skillsRoot)
    .filter((name) => name.startsWith('add-') || CHANNEL_COMPANION_SKILLS.has(name))
    .flatMap((skill) => {
      const dir = join(skillsRoot, skill);
      const path = join(dir, 'SKILL.md');
      if (!existsSync(path)) return [];
      const markdown = readFileSync(path, 'utf8');
      const directives = parseDirectives(markdown);
      const provider = parseProviderDescriptor(markdown, skill)?.value;
      const channel = directives.some(
        (d) =>
          d.kind === 'copy' && d.body.some((line) => (line.split('->')[1] ?? line).trim().startsWith('src/channels/')),
      );
      const hasLocalCopy = directives.some((d) => d.kind === 'copy' && !d.attrs['from-branch']);
      const localPayload = (Boolean(provider) || channel) && hasLocalCopy;
      if (![...markdown.matchAll(REGISTRY_MENTION)].length && !localPayload) {
        if (hasLocalCopy) {
          warn?.(
            `WARN: ${skill} skipped: its payload is neither a channel nor a provider, so no registry job tests it`,
          );
        }
        return [];
      }
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
          provider,
          channel,
          bun: markdown.includes('container/agent-runner'),
          executable: branches.length > 0 || localPayload,
          dir,
          markdown,
        },
      ];
    })
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

/** The skills each `test` matrix job applies alone to a fresh core. */
export function matrixSkills(skills: RegistrySkill[]): RegistrySkill[] {
  return skills.filter(({ skill }) => !CHANNEL_COMPANION_SKILLS.has(skill));
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
  return requireAvailable(
    'provider',
    providerSkills,
    hasSource,
    "Ship the provider payloads in each skill's payload/ (or pin REGISTRY_PROVIDERS_SHA to a commit that carries them) before this core lands.",
  ) as Array<RegistrySkill & { provider: string }>;
}

/**
 * The channel adapters `--combined-channels` loads together, plus branch-only companions like
 * slack-agent-flow. Every one must apply: `/add-<name>` cannot install a skill whose channels
 * files are missing, and skipping it would pass with that adapter untested.
 */
export function selectCombinedChannels(skills: RegistrySkill[], hasSource: RegistrySourceCheck): RegistrySkill[] {
  const { available, unavailable } = partitionRegistryAvailability(
    skills.filter((skill) => skill.channel || skill.branches.includes('channels')),
    hasSource,
  );
  if (unavailable.length) {
    throw new Error(
      'FAIL: the channels registry lacks files these channel skills copy:\n' +
        unavailable.map(({ skill, missing }) => `  ${skill.skill} (missing: ${missing.join(', ')})`).join('\n') +
        "\nShip the adapters in each skill's payload/ (or pin REGISTRY_CHANNELS_SHA to a commit that carries them) before this core lands.",
    );
  }
  return available;
}

function requireAvailable(
  kind: 'channel' | 'provider',
  skills: RegistrySkill[],
  hasSource: RegistrySourceCheck,
  fix: string,
): RegistrySkill[] {
  const { available, unavailable } = partitionRegistryAvailability(skills, hasSource);
  warnUnavailable(unavailable);
  if (skills.length && !available.length) {
    throw new Error(
      `FAIL: trunk carries ${kind} skills (${skills.map(({ skill }) => skill).join(', ')}) ` +
        `but none is available in the ${kind}s registry:\n` +
        unavailable.map((entry) => `  ${formatUnavailable(entry)}`).join('\n') +
        `\n${fix}`,
    );
  }
  return available;
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
    throw new Error(`${meta.skill} has no executable nc:copy source`);
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

  const apply = (effects = skipEffects) =>
    applySkill(meta.dir, root, {
      inputs: fixture.inputs ?? {},
      skipEffects: effects,
      resolveRemote: () => 'skill-ci',
      onEvent: (event) => {
        if (event.type === 'step-start') current = byLine.get(event.line);
      },
      exec: (cmd) => {
        // These refs are pinned above; skill-ci is not a network remote here.
        if ([...REGISTRY_BRANCHES].some((branch) => cmd === gitFetchBranchCommand('skill-ci', branch))) return '';
        const stub = fixture.exec?.find((candidate) => cmd.includes(candidate.match));
        if (stub) return stub.stdout;
        if (current?.kind === 'run' && STUBBED_EFFECTS.has(String(current.attrs.effect))) {
          return '';
        }
        return command(cmd, root);
      },
      execStream: async () => ({ ok: true, fields: fixture.stepFields ?? {} }),
    });

  const before = roundTrip && (meta.provider || meta.branches.includes('providers')) ? snapshot(root) : undefined;
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
    // The snapshot below proves the re-add restores the first install byte for
    // byte, so its build and test steps would only repeat the first pass.
    const reapplied = await apply([...skipEffects, 'build', 'test']);
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
    await command('pnpm install --frozen-lockfile --prefer-offline', root);
    await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    for (const meta of selected) {
      console.log(`\n==> ${meta.skill}`);
      await testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, refs, false, [...SKIPPED_EFFECTS, 'build', 'test']);
    }

    // Only a skill that copies from the branch pins its commit in testSkill, so a
    // payload-only selection would leave the object missing from this clone.
    pinRegistryRef(root, 'providers', refs.providers);
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
      expectedLegacyProviders: [],
      requiredDeclaredProviders: expected,
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

const CHANNEL_BARREL = 'src/channels/index.ts';

/** Line numbers of the guarded copy, barrel and dependency directives the refresh checks leave out. */
export function guardedDirectives(meta: RegistrySkill): number[] {
  return parseDirectives(meta.markdown)
    .filter((directive) => ['copy', 'append', 'dep'].includes(directive.kind) && directive.attrs.when)
    .map((directive) => directive.line);
}

/** Any barrel append, guarded or not: what update-skills attributes an installed import to. */
function addsBarrelImport(meta: RegistrySkill): boolean {
  return parseDirectives(meta.markdown).some((d) => d.kind === 'append' && d.attrs.to === CHANNEL_BARREL);
}

/** Each unguarded nc:append line, with the file it goes into. */
export function appendLines(meta: RegistrySkill): { to: string; line: string }[] {
  return parseDirectives(meta.markdown)
    .filter(
      (directive) => directive.kind === 'append' && typeof directive.attrs.to === 'string' && !directive.attrs.when,
    )
    .flatMap((directive) =>
      directive.body.map((line) => ({ to: String(directive.attrs.to), line: line.trim() })).filter(({ line }) => line),
    );
}

/**
 * Every adapter registers itself in the barrel, and each unguarded append line is in
 * its file exactly once, so a later install-mode apply cannot be what adds it.
 */
export function appendProblems(root: string, installed: RegistrySkill[]): string[] {
  const files = new Map<string, string[]>();
  const linesOf = (file: string): string[] => {
    let lines = files.get(file);
    if (!lines) {
      const path = join(root, file);
      lines = existsSync(path)
        ? readFileSync(path, 'utf8')
            .split('\n')
            .map((line) => line.trim())
        : [];
      files.set(file, lines);
    }
    return lines;
  };
  return installed.flatMap((meta) => {
    if (meta.channel && !addsBarrelImport(meta)) return [`${meta.skill} adds no ${CHANNEL_BARREL} import`];
    return appendLines(meta)
      .filter(({ to, line }) => linesOf(to).filter((candidate) => candidate === line).length !== 1)
      .map(({ to, line }) => `${meta.skill}: ${to} must hold "${line}" exactly once`);
  });
}

/** Each unguarded nc:dep pin is in its package.json exactly, so a later install-mode apply cannot be what adds it. */
export function dependencyProblems(root: string, meta: RegistrySkill): string[] {
  return parseDirectives(meta.markdown)
    .filter((directive) => directive.kind === 'dep' && !directive.attrs.when)
    .flatMap((directive) => {
      const file = join(typeof directive.attrs.cwd === 'string' ? directive.attrs.cwd : '', 'package.json');
      const pkg = JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, Record<string, string>>;
      return directive.body
        .filter((spec) => {
          const name = spec.slice(0, spec.lastIndexOf('@'));
          const found = [pkg.dependencies?.[name], pkg.devDependencies?.[name]].filter(Boolean);
          return !found.length || found.some((version) => version !== spec.slice(name.length + 1));
        })
        .map((spec) => `${meta.skill}: ${file} lacks ${spec}`);
    });
}

/**
 * Refresh every installed skill against the pinned channels commit, then check
 * what it left: the selection, each copy against its source, every append and the
 * dependency pins. Copies go stale first, so a copy the refresh skipped shows.
 */
async function channelRefreshProblems(
  root: string,
  refs: Record<string, string>,
  installed: RegistrySkill[],
): Promise<string[]> {
  // update-skills must find every install, slack-agent-flow included; one it misses is a problem below.
  for (const meta of installed) {
    const lines = guardedDirectives(meta);
    if (lines.length) console.error(`WARN: ${meta.skill}'s when: directives (lines ${lines}) are not checked`);
  }
  // A trailing newline changes the blob and stays valid text. Patch files are left alone: pnpm re-checks them on every add.
  for (const { dest } of installed.flatMap(copySources)) {
    if (!dest.endsWith('.patch') && existsSync(join(root, dest))) appendFileSync(join(root, dest), '\n');
  }
  pinRegistryRef(root, 'channels', refs.channels);
  git(['update-ref', 'refs/heads/channels', refs.channels], root);
  git(['remote', 'remove', 'origin'], root);
  git(['remote', 'add', 'skill-ci', '.'], root);
  const report = await refreshInstalledSkills(root, 'all', { exec: (cmd, cwd) => command(cmd, cwd) });
  const expected = installed.map(({ skill }) => skill);
  const actual = report.skills.map(({ skillName }) => skillName);
  const problems = [
    ...actual.filter((name) => !expected.includes(name)).map((name) => `update-skills selected ${name}, not installed`),
    ...expected.filter((name) => !actual.includes(name)).map((name) => `update-skills missed installed ${name}`),
    ...report.skills
      .filter(({ status }) => status === 'failed')
      .map((skill) => `update-skills could not refresh ${skill.skillName}: ${skill.errors.join('; ')}`),
  ];
  for (const meta of installed) {
    for (const { dest, branch, source } of copySources(meta)) {
      const want = branch ? git(['rev-parse', `${refs[branch]}:${source}`], root) : hashFile(join(meta.dir, source));
      if (hashFile(join(root, dest)) !== want) {
        problems.push(`${meta.skill}: ${dest} differs from ${branch ?? meta.skill}:${source}`);
      }
    }
  }
  return [
    ...problems,
    ...appendProblems(root, installed),
    ...installed.flatMap((meta) => dependencyProblems(root, meta)),
  ];
}

// Each problem is collected, not thrown, so one run names every break.
async function check(problems: string[], label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Every channel skill applied into one tree, the way a fork with many adapters
 * looks: no per-skill matrix job loads two adapters together.
 */
async function testCombinedChannels(skills: RegistrySkill[]): Promise<void> {
  const refs = resolveRegistryRefs();
  const selected = selectCombinedChannels(skills, registrySourceCheck(refs));
  if (!selected.length) {
    console.log('\nPASS: trunk carries no channel skills to combine');
    return;
  }
  const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-channel-ci-'));
  const root = join(temp, 'repo');
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
    git(['checkout', '--quiet', '--detach', git(['rev-parse', 'HEAD'])], root);
    await command('pnpm install --frozen-lockfile --prefer-offline', root);
    await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    for (const meta of selected) {
      console.log(`\n==> ${meta.skill}`);
      await testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, refs, false, [...SKIPPED_EFFECTS, 'build', 'test']);
    }
    const problems = appendProblems(root, selected);
    await check(problems, 'host typecheck', () => command('pnpm exec tsc --noEmit', root));
    await check(problems, 'container typecheck', () =>
      command('pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit', root),
    );
    // About 550 more tests than trunk's suite on the same runner: a slow git fixture is not an adapter break.
    await check(problems, 'host tests', () =>
      command('pnpm exec vitest run --testTimeout=20000 --hookTimeout=40000', root),
    );
    await check(problems, 'container tests', () => command('bun run test', join(root, 'container/agent-runner')));
    problems.push(...(await channelRefreshProblems(root, refs, selected)));
    if (problems.length) throw new Error(`combined channels failed:\n${[...new Set(problems)].join('\n')}`);
    console.log(`\nPASS: ${selected.map(({ skill }) => skill).join(', ')} install, build, test and refresh together`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const DEPENDENCY_FILES = new Set(['package.json', 'pnpm-lock.yaml']);
const CI_GIT = ['-c', 'user.name=skill-ci', '-c', 'user.email=skill-ci@localhost', '-c', 'commit.gpgsign=false'];

/**
 * A stricter stand-in for /update-nanoclaw's default merge. The real updater stops at a
 * conflict for a person to resolve; here a conflict in the dependency files takes the new
 * core's copy and the refresh must restore each adapter's pins. Any other conflict fails.
 */
function mergeCore(root: string, core: string): void {
  git([...CI_GIT, 'add', '--all'], root);
  git([...CI_GIT, 'commit', '--quiet', '--no-verify', '-m', 'fork: installed channels'], root);
  const merge = spawnSync('git', [...CI_GIT, 'merge', '--quiet', '--no-edit', '--no-verify', core], {
    cwd: root,
    encoding: 'utf8',
  });
  if (merge.status === 0) return;
  const conflicted = git(['diff', '--name-only', '--diff-filter=U'], root).split('\n').filter(Boolean);
  const other = conflicted.filter((file) => !DEPENDENCY_FILES.has(file));
  if (!conflicted.length || other.length) {
    throw new Error(`merging ${core} into the old install conflicts: ${other.join(', ') || merge.stderr}`);
  }
  console.log(`  merge conflict in ${conflicted.join(', ')}: taking the new core's copy`);
  git(['checkout', '--theirs', '--', ...conflicted], root);
  git(['add', '--', ...conflicted], root);
  git([...CI_GIT, 'commit', '--quiet', '--no-verify', '--no-edit'], root);
}

/**
 * A host on old trunk `commit` with the common adapters installed from the
 * channels branch updates to this core: the refresh must select exactly those
 * adapters, put each file at the source today's SKILL.md names, and pass each skill's own checks.
 */
async function testOldChannelRefresh(commit: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('old trunk must be a full commit SHA');

  ensureCommit(commit);
  const refs = resolveRegistryRefs();
  const core = git(['rev-parse', 'HEAD']);
  const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-old-channel-refresh-ci-'));
  const root = join(temp, 'repo');
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
    git(['checkout', '--quiet', '--detach', commit], root);
    await command('pnpm install --frozen-lockfile --prefer-offline', root);
    await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    const pick = () => discover(join(root, '.claude/skills')).filter(({ skill }) => OLD_CHANNEL_SKILLS.includes(skill));
    // Adapters come from today's channels commit, not the one current at that release:
    // the stale copies made before the refresh stand in for older adapter code.
    const oldSkills = pick();
    if (oldSkills.length !== OLD_CHANNEL_SKILLS.length) throw new Error('old trunk is missing a channel skill');
    for (const meta of oldSkills) {
      console.log(`\n==> install ${meta.skill} from channels ${refs.channels} on ${commit}`);
      await testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, refs, false, [...SKIPPED_EFFECTS, 'build', 'test']);
    }

    console.log(`\n==> merge ${core} and refresh`);
    mergeCore(root, core);
    const skills = pick();
    const problems = await channelRefreshProblems(root, refs, skills);
    await command('pnpm install --frozen-lockfile --prefer-offline', root);
    await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));
    for (const meta of skills) {
      console.log(`\n==> ${meta.skill}'s own build and test on the refreshed install`);
      await check(problems, meta.skill, () => testSkill(meta, fixtureScenarios(meta)[0] ?? {}, root, refs, false));
    }
    if (problems.length) throw new Error(`old channel refresh failed:\n${problems.join('\n')}`);
    console.log(`\nPASS: ${OLD_CHANNEL_SKILLS.join(', ')} on ${commit} refreshed onto ${core}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function hashFile(file: string): string {
  return existsSync(file) ? git(['hash-object', '--', file]) : 'missing';
}

async function testOldProviderRefresh(commit: string, only: string[] = []): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('old trunk must be a full commit SHA');
  const legacySkills = only.length
    ? LEGACY_PROVIDER_SKILLS.filter((name) => only.includes(name))
    : LEGACY_PROVIDER_SKILLS;
  if (legacySkills.length !== (only.length || LEGACY_PROVIDER_SKILLS.length))
    throw new Error(`legacy provider skills are ${LEGACY_PROVIDER_SKILLS.join(', ')}`);

  ensureCommit(commit);
  const currentRefs = resolveRegistryRefs();
  ensureCommit(PRE_CONTRACT_PROVIDERS_SHA);
  const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-old-provider-refresh-ci-'));
  const root = join(temp, 'repo');
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
    git(['fetch', '--quiet', 'origin', commit], root);
    git(['checkout', '--quiet', '--detach', commit], root);
    await command('pnpm install --frozen-lockfile --prefer-offline', root);
    await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    const oldSkills = legacySkills.map((name) =>
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
    const expected = legacySkills.map((name) => name.replace(/^add-/, '')).sort();
    if (JSON.stringify(report.selected) !== JSON.stringify(expected) || !report.success) {
      throw new Error(`old-install provider refresh failed: ${JSON.stringify(report)}`);
    }
    if (legacySkills.includes('add-opencode') && !existsSync(join(root, 'src/opencode-cli-tools.test.ts'))) {
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

/**
 * Provider skills that copied from the providers branch at `commit` and ship
 * their own payload now. Installed with the old SKILL.md onto this core, then
 * refreshed with no registry remote left, they must match a fresh install.
 */
async function testProviderPayloadSwitch(commit: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('branch-install trunk must be a full commit SHA');

  ensureCommit(commit);
  const refs = resolveRegistryRefs();
  const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-provider-switch-ci-'));
  const root = join(temp, 'repo');
  try {
    git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
    git(['checkout', '--quiet', '--detach', git(['rev-parse', 'HEAD'])], root);
    await command('pnpm install --frozen-lockfile --prefer-offline', root);
    await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

    const moved = discover(join(root, '.claude/skills'))
      .filter((meta) => meta.provider && !meta.branches.length)
      .flatMap((current) => {
        if (!git(['ls-tree', '--name-only', commit, '--', `.claude/skills/${current.skill}/SKILL.md`])) return [];
        const legacy = materializeSkill(commit, current.skill, join(temp, 'skills'));
        return legacy.branches.includes('providers') ? [{ current, legacy }] : [];
      });
    if (!moved.length) throw new Error(`no provider skill moved off the providers branch since ${commit}`);
    const skipEffects = [...SKIPPED_EFFECTS, 'build', 'test'];
    // Every copy destination, ignored ones included: snapshot() skips files like an ignored AGENTS.md.
    const copied = [
      ...new Set(
        moved.flatMap(({ current, legacy }) =>
          [current, legacy].flatMap((meta) =>
            parseDirectives(meta.markdown)
              .filter((directive) => directive.kind === 'copy')
              .flatMap((directive) => directive.body.map((line) => (line.split('->')[1] ?? line).trim())),
          ),
        ),
      ),
    ].sort();
    const state = () => {
      const files = snapshot(root);
      for (const file of copied) files.set(file, fileState(root, file));
      return files;
    };

    for (const { current } of moved) {
      console.log(`\n==> fresh payload install of ${current.skill}`);
      await testSkill(current, fixtureScenarios(current)[0] ?? {}, root, refs, false, skipEffects);
    }
    const fresh = state();
    git(['reset', '--quiet', '--hard'], root);
    git(['clean', '--quiet', '-fd'], root);
    git(['clean', '--quiet', '-fX', '--', ...copied], root);

    for (const { legacy } of moved) {
      console.log(`\n==> ${legacy.skill} from providers ${refs.providers} with the SKILL.md of ${commit}`);
      await testSkill(legacy, fixtureScenarios(legacy)[0] ?? {}, root, refs, false, skipEffects);
    }
    // Setup's install path re-applies today's skill over a branch install. Install
    // mode only fills gaps, so it must not change or remove a file already there.
    const branchInstall = state();
    for (const { current } of moved) {
      console.log(`\n==> ${current.skill} re-applied in install mode over the branch install`);
      await testSkill(current, fixtureScenarios(current)[0] ?? {}, root, refs, false, skipEffects);
    }
    const afterInstall = state();
    const disturbed = [...branchInstall]
      .filter(([file, hash]) => hash !== 'missing' && afterInstall.get(file) !== hash)
      .map(([file]) => file);
    if (disturbed.length) throw new Error(`install over a branch install changed or removed: ${disturbed.join(', ')}`);
    // The locked branch still matches the payload, so make each copy stale: the refresh must rewrite all of them.
    for (const file of copied) if (existsSync(join(root, file))) appendFileSync(join(root, file), '\n// stale\n');
    // No registry ref or remote is left, so a refresh that still reads the branch fails.
    git(['update-ref', '-d', 'refs/remotes/skill-ci/providers'], root);
    git(['remote', 'remove', 'origin'], root);
    const report = await refreshInstalledSkills(root, 'all', {
      exec: (cmd, cwd) => command(cmd, cwd),
    });
    const expected = moved.map(({ current }) => current.provider).sort();
    if (JSON.stringify(report.selected) !== JSON.stringify(expected) || !report.success) {
      throw new Error(`payload refresh of a branch install failed: ${JSON.stringify(report)}`);
    }
    assertSnapshot('payload refresh of a branch install differs from a fresh install', fresh, state());
    console.log(
      `\nPASS: ${expected.join(', ')} installed from providers ${refs.providers} and refreshed to the payload`,
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
    await command('pnpm install --frozen-lockfile --prefer-offline', root);
    await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));

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
      failures.push(`${meta.skill}: no executable nc:copy source`);
      console.error(`  FAIL: ${failures.at(-1)}`);
      continue;
    }

    const temp = mkdtempSync(join(tmpdir(), 'nanoclaw-skill-ci-'));
    const root = join(temp, 'repo');
    try {
      git(['clone', '--quiet', '--shared', '--no-checkout', SOURCE_ROOT, root]);
      git(['checkout', '--quiet', '--detach', head], root);
      await command('pnpm install --frozen-lockfile --prefer-offline', root);
      if (meta.bun) await command('bun install --frozen-lockfile', join(root, 'container/agent-runner'));
      const scenarios = fixtureScenarios(meta);
      for (const [index, fixture] of scenarios.entries()) {
        const scenario = fixture.name ?? String(index + 1);
        if (scenarios.length > 1) console.log(`  scenario: ${scenario}`);
        try {
          await testSkill(
            meta,
            fixture,
            root,
            refs,
            index === 0 && Boolean(meta.provider || meta.branches.includes('providers')),
          );
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
  const all = discover(SKILLS_ROOT, (message) => console.error(message));
  const skills = matrixSkills(all);
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
  } else if (arg === '--combined-channels') {
    await testCombinedChannels(all);
  } else if (arg === '--old-channel-refresh') {
    await testOldChannelRefresh(process.argv[3] ?? '');
  } else if (arg === '--old-provider-refresh') {
    await testOldProviderRefresh(process.argv[3] ?? '', process.argv.slice(4));
  } else if (arg === '--pre-contract-providers') {
    await testPreContractProviders();
  } else if (arg === '--provider-payload-switch') {
    await testProviderPayloadSwitch(process.argv[3] ?? '');
  } else if (arg) {
    const meta = skills.find((candidate) => candidate.skill === basename(arg));
    if (!meta) throw new Error(`unknown registry skill: ${arg}`);
    // The matrix lists every skill; one whose registry source is missing is
    // skipped here, as --list-available used to leave it out of the matrix.
    const { unavailable } = partitionRegistryAvailability([meta], registrySourceCheck(resolveRegistryRefs()));
    if (unavailable.length) {
      warnUnavailable(unavailable);
      console.log(`SKIP: ${meta.skill} has no registry source to install from`);
      return;
    }
    await testAll([meta]);
  } else {
    console.error(
      'usage: pnpm exec tsx scripts/test-registry-skills.ts --list|--list-available|--all [skill...]|--combined-providers|--combined-channels|--old-provider-refresh <sha> [skill...]|--old-channel-refresh <sha>|--pre-contract-providers|--provider-payload-switch <sha>|<skill>',
    );
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
