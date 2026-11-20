import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applySkill, fullyApplied, type DependencyCommandRequest } from './skill-apply.js';
import { parseDirectives, type Directive } from './skill-directives.js';
import { pinnedBunVersion } from './provider-contract-verifier.js';

export type InstalledSkillKind = 'channel' | 'provider' | 'gateway';

export interface InstalledSkill {
  name: string;
  skillName: string;
  kind: InstalledSkillKind;
}

export interface SkillRefreshResult {
  name: string;
  skillName: string;
  kind: InstalledSkillKind;
  status: 'refreshed' | 'failed';
  applied: string[];
  skipped: string[];
  errors: string[];
}

export interface SkillsRefreshReport {
  schema: 'nanoclaw-skill-refresh/v1';
  schemaVersion: 1;
  success: boolean;
  selected: string[];
  remotes: Record<string, string>;
  skills: SkillRefreshResult[];
}

interface RefreshOptions {
  commandAvailable?: (command: string, cwd: string) => boolean;
  exec?: (command: string, cwd: string) => string | void | Promise<string | void>;
  /** Skills detection cannot see, such as a gateway whose barrel import is not there yet. */
  include?: InstalledSkill[];
}

function commandAvailable(command: string, cwd: string): boolean {
  try {
    execFileSync(command, ['--version'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

export function portableDependencyCommand(root: string, bunOnHost: boolean, request: DependencyCommandRequest): string {
  const prefix = request.cwd ? `cd ${request.cwd} && ` : '';
  const manager =
    request.manager === 'bun' && !bunOnHost ? `pnpm --package=bun@${pinnedBunVersion(root)} dlx bun` : request.manager;
  return `${prefix}${manager} ${request.action} ${request.packages.join(' ')}`;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(root: string, args: string[]): string {
  try {
    return git(root, args);
  } catch {
    return '';
  }
}

function readImports(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const names: string[] = [];
  const re = /^\s*import\s+['"]\.\/([a-z0-9-]+)\.js['"];?\s*$/gm;
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(re)) names.push(match[1]);
  return names;
}

/**
 * Which installed skill owns each barrel import, read from the skills' own
 * `append to:<barrel>` directives.
 *
 * A skill may append more than one import to a barrel: `add-slack` registers
 * both `slack.js` and the `slack-a2a-guard.js` companion module. Mapping every
 * import to its own `add-<name>` skill would demand an `add-slack-a2a-guard`
 * that does not and should not exist. An import a skill declares belongs to
 * that skill; only an unclaimed one is attributed to `add-<name>`, which is
 * what keeps the missing-skill check meaningful for a channel installed
 * without one.
 */
function importOwners(skills: [string, Directive[]][], barrel: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [skillName, directives] of skills) {
    for (const directive of directives) {
      if (directive.kind !== 'append' || path.posix.normalize(String(directive.attrs.to)) !== barrel) continue;
      for (const line of directive.body) {
        const match = /^\s*import\s+['"]\.\/([a-z0-9-]+)\.js['"];?\s*$/.exec(line);
        if (!match) continue;
        // add-<name> always owns <name>, whichever other skill also declares it.
        if (!owners.has(match[1]) || skillName === `add-${match[1]}`) owners.set(match[1], skillName);
      }
    }
  }
  return owners;
}

/** Every skill's parsed directives, sorted so a contested line resolves the same way on every filesystem. */
function skillDirectives(root: string): [string, Directive[]][] {
  const skillsDir = path.join(root, '.claude/skills');
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir)
    .sort()
    .flatMap((skillName): [string, Directive[]][] => {
      const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
      if (!fs.existsSync(skillFile)) return [];
      try {
        return [[skillName, parseDirectives(fs.readFileSync(skillFile, 'utf8'))]];
      } catch {
        // A skill we cannot parse simply claims nothing; refresh reports its own
        // parse failure with a better message than detection could.
        return [];
      }
    });
}

/**
 * Skills that copy from the channels branch but add no channel barrel import,
 * such as slack-agent-flow. Each counts as installed when a line that only it
 * appends is in its file.
 */
function channelCompanions(skills: [string, Directive[]][], barrel: string, root: string): string[] {
  const appends = (directives: Directive[]) =>
    directives
      .filter((d) => d.kind === 'append' && typeof d.attrs.to === 'string' && !d.attrs.when)
      .flatMap((d) => d.body.map((line) => ({ to: path.posix.normalize(String(d.attrs.to)), line })));
  const owners = new Map<string, number>();
  for (const [, directives] of skills) {
    for (const key of new Set(appends(directives).map(({ to, line }) => `${to}\n${line}`))) {
      owners.set(key, (owners.get(key) ?? 0) + 1);
    }
  }
  const hasLine = (to: string, line: string) => {
    const file = path.join(root, to);
    return (
      fs.existsSync(file) &&
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .some((l) => l.trim() === line)
    );
  };
  return skills
    .filter(
      ([, directives]) =>
        directives.some((d) => d.kind === 'copy' && d.attrs['from-branch'] === 'channels') &&
        !appends(directives).some(({ to }) => to === barrel) &&
        appends(directives).some(({ to, line }) => owners.get(`${to}\n${line}`) === 1 && hasLine(to, line)),
    )
    .map(([skillName]) => skillName);
}

export function detectInstalledSkills(root: string): InstalledSkill[] {
  const channelBarrel = 'src/channels/index.ts';
  const skills = skillDirectives(root);
  const owners = importOwners(skills, channelBarrel);
  // A skill that owns several imports is refreshed once, under its own name.
  const channelSkills = new Set([
    ...readImports(path.join(root, channelBarrel))
      .filter((name) => name !== 'cli')
      .map((name) => owners.get(name) ?? `add-${name}`),
    ...channelCompanions(skills, channelBarrel, root),
  ]);
  const channels = [...channelSkills].map((skillName) => ({
    name: skillName.startsWith('add-') ? skillName.slice('add-'.length) : skillName,
    skillName,
    kind: 'channel' as const,
  }));
  const providers = new Set([
    ...readImports(path.join(root, 'src/providers/index.ts')),
    ...readImports(path.join(root, 'container/agent-runner/src/providers/index.ts')),
  ]);
  providers.delete('claude');

  return [
    ...channels,
    ...[...providers].sort().map((name) => ({
      name,
      skillName: `add-${name}`,
      kind: 'provider' as const,
    })),
  ].sort((a, b) => a.skillName.localeCompare(b.skillName));
}

export function resolveRegistryRemote(root: string, branch: string): string {
  const override = process.env.NANOCLAW_REGISTRY_REMOTE ?? process.env.NANOCLAW_CHANNELS_REMOTE;
  if (override) {
    const remotes = git(root, ['remote']).split('\n').filter(Boolean);
    if (!remotes.includes(override)) throw new Error(`Registry remote ${override} does not exist`);
    if (!tryGit(root, ['ls-remote', '--heads', override, branch])) {
      throw new Error(`Registry remote ${override} has no ${branch} branch`);
    }
    return override;
  }

  const remotes = git(root, ['remote'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const ordered = remotes.includes('origin') ? ['origin', ...remotes.filter((remote) => remote !== 'origin')] : remotes;
  for (const remote of ordered) {
    if (tryGit(root, ['ls-remote', '--heads', remote, branch])) return remote;
  }
  throw new Error(`No configured remote carries the ${branch} registry branch`);
}

export async function refreshInstalledSkills(
  root: string,
  requested: 'all' | string[] = 'all',
  options: RefreshOptions = {},
): Promise<SkillsRefreshReport> {
  const installed = [...detectInstalledSkills(root), ...(options.include ?? [])];
  const selected =
    requested === 'all'
      ? installed
      : installed.filter((skill) => requested.includes(skill.name) || requested.includes(skill.skillName));
  const missing =
    requested === 'all'
      ? []
      : requested.filter((name) => !selected.some((skill) => skill.name === name || skill.skillName === name));
  if (missing.length > 0) throw new Error(`Requested skills are not installed: ${missing.join(', ')}`);

  const remotes: Record<string, string> = {};
  const results: SkillRefreshResult[] = [];
  const bunOnHost = (options.commandAvailable ?? commandAvailable)('bun', root);

  for (const skill of selected) {
    const skillDir = path.join(root, '.claude/skills', skill.skillName);
    const errors: string[] = [];
    if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
      errors.push(`Missing ${path.relative(root, path.join(skillDir, 'SKILL.md'))}`);
    } else {
      const directives = parseDirectives(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'));
      if (directives.length === 0) {
        errors.push('Skill has no structured apply directives and cannot be refreshed headlessly');
      }
    }

    if (errors.length > 0) {
      results.push({ ...skill, status: 'failed', applied: [], skipped: [], errors });
      continue;
    }

    try {
      const result = await applySkill(skillDir, root, {
        mode: 'refresh',
        exec: (command) => {
          if (options.exec) return options.exec(command, root);
          return execSync(command, {
            cwd: root,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        },
        resolveDependencyCommand: (request) => portableDependencyCommand(root, bunOnHost, request),
        resolveRemote: (branch) => {
          const remote = remotes[branch] ?? resolveRegistryRemote(root, branch);
          remotes[branch] = remote;
          return remote;
        },
      });
      errors.push(...result.deferred, ...result.agentTasks.map((task) => task.reason));
      results.push({
        ...skill,
        status: fullyApplied(result) ? 'refreshed' : 'failed',
        applied: result.applied,
        skipped: result.skipped,
        errors,
      });
    } catch (err) {
      results.push({
        ...skill,
        status: 'failed',
        applied: [],
        skipped: [],
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }

  return {
    schema: 'nanoclaw-skill-refresh/v1',
    schemaVersion: 1,
    success: results.every((result) => result.status === 'refreshed'),
    selected: selected.map((skill) => skill.name),
    remotes,
    skills: results,
  };
}

interface CliArgs {
  root: string;
  requested: 'all' | string[];
}

function parseCliArgs(argv: string[]): CliArgs {
  let root = process.cwd();
  let requested: 'all' | string[] = 'all';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') root = path.resolve(argv[++i] ?? '');
    else if (argv[i] === '--skills') {
      const value = argv[++i] ?? 'all';
      requested =
        value === 'all'
          ? 'all'
          : value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return { root, requested };
}

async function main(): Promise<void> {
  const { root, requested } = parseCliArgs(process.argv.slice(2));
  if (git(root, ['status', '--porcelain'])) {
    throw new Error('Working tree must be clean before refreshing installed skills');
  }
  const report = await refreshInstalledSkills(root, requested);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.success) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
