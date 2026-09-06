import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applySkill, fullyApplied, type DependencyCommandRequest } from './skill-apply.js';
import { parseDirectives } from './skill-directives.js';

export type InstalledSkillKind = 'channel' | 'provider';

export interface InstalledSkill {
  name: string;
  skillName: string;
  kind: InstalledSkillKind;
}

export interface SkillRefreshResult {
  name: string;
  skillName: string;
  kind: InstalledSkillKind;
  /** `local` = deliberately not registry-managed; the refresh touched nothing. */
  status: 'refreshed' | 'failed' | 'local';
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

function pinnedBunVersion(root: string): string {
  const dockerfile = fs.readFileSync(path.join(root, 'container/Dockerfile'), 'utf8');
  const match = dockerfile.match(/^ARG BUN_VERSION=([^\s#]+)$/m);
  if (!match) throw new Error('container/Dockerfile does not declare an exact BUN_VERSION');
  return match[1];
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

/**
 * `refresh: local` in SKILL.md's YAML frontmatter marks the skill's payload
 * as fork-owned: the operator replaced or patched the adapter deliberately,
 * and the registry refresh must leave it alone instead of silently swapping
 * the registry copy back in (#3529). Only the frontmatter block (between the
 * leading `---` fences) is consulted, so prose mentioning the phrase can't
 * trip it.
 */
export function isLocalSkill(skillMdPath: string): boolean {
  const source = fs.readFileSync(skillMdPath, 'utf8');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return /^refresh:\s*local\s*$/m.test(match[1]);
}

function readImports(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const names: string[] = [];
  const re = /^\s*import\s+['"]\.\/([a-z0-9-]+)\.js['"];?\s*$/gm;
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(re)) names.push(match[1]);
  return names;
}

export function detectInstalledSkills(root: string): InstalledSkill[] {
  const channels = readImports(path.join(root, 'src/channels/index.ts'))
    .filter((name) => name !== 'cli')
    .map((name) => ({ name, skillName: `add-${name}`, kind: 'channel' as const }));
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
  const installed = detectInstalledSkills(root);
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
    const skillMd = path.join(skillDir, 'SKILL.md');
    const errors: string[] = [];
    if (!fs.existsSync(skillMd)) {
      // A barrel import with no skill directory is a LOCAL adapter — code the
      // fork owns, not registry output that rotted. Treating it as a hard
      // failure blocked the whole update for forks carrying their own
      // adapters (#3529); the refresh has nothing to refresh, so report it
      // and move on.
      results.push({ ...skill, status: 'local', applied: [], skipped: [], errors: [] });
      continue;
    }
    if (isLocalSkill(skillMd)) {
      // Explicit opt-out (`refresh: local` frontmatter): the adapter files
      // are deliberately fork-owned — a replaced upstream adapter, or local
      // patches the operator wants to keep. Never overwrite them.
      results.push({ ...skill, status: 'local', applied: [], skipped: [], errors: [] });
      continue;
    }
    const directives = parseDirectives(fs.readFileSync(skillMd, 'utf8'));
    if (directives.length === 0) {
      errors.push(
        'Skill has no structured apply directives and cannot be refreshed headlessly ' +
          '(mark it `refresh: local` in SKILL.md frontmatter if it is deliberately fork-owned)',
      );
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
    // `local` skills are a healthy outcome: deliberately not registry-managed,
    // nothing was (or should be) refreshed. Only real refresh failures block.
    success: results.every((result) => result.status !== 'failed'),
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
