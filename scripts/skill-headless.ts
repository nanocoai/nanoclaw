#!/usr/bin/env tsx
// Headless skill engine entry: list / plan / apply, JSON in and out.
//
// The consumer of the skill-engine seam for callers with no human at a TTY —
// `ncl skills` on the host (an agent's request, held for admin approval) and
// pipelines. The prose in each SKILL.md stays authoritative: anything the
// engine cannot do deterministically is reported as an agent task, never
// improvised, and an install that does not fully apply is rolled back through
// the engine's journal unless the caller asks to keep the partial state.
//
// Usage (always prints one JSON document to stdout):
//   pnpm exec tsx scripts/skill-headless.ts list [--root <dir>]
//   pnpm exec tsx scripts/skill-headless.ts plan <skill> [--root <dir>]
//   pnpm exec tsx scripts/skill-headless.ts apply <skill> [--root <dir>] [--inputs <json>]
//        [--refresh] [--no-secret-inputs] [--keep-partial] [--allow-dirty]
//
// Exit code 0 when the request succeeded (list, plan, or a fully applied skill);
// 1 otherwise — the JSON carries the reason.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import {
  CALLER_OWNED_EFFECTS,
  SKILL_APPLY_SCHEMA,
  assertSkillName,
  isPlainObject,
  type SkillApplyReport,
  type SkillKind,
  type SkillPlan,
  type SkillPromptSummary,
  type SkillSummary,
} from '../src/cli/skill-report.js';
import {
  applySkill,
  firstFailureHint,
  fullyApplied,
  planSkill,
  promptMeta,
  removeSkill,
  type ApplyOptions,
  type ApplyResult,
} from './skill-apply.js';
import { isSecretPrompt, parseDirectives, promptVar, registryBranches, type Directive } from './skill-directives.js';
import {
  commandAvailable,
  detectInstalledSkills,
  git,
  hostShellExec,
  portableDependencyCommand,
  resolveRegistryRemote,
} from './update-skills.js';

export interface ApplyHeadlessOptions {
  inputs?: Record<string, string>;
  /** Re-copy an installed skill's files and re-pin its dependencies. Needs a clean tree; never rolled back. */
  refresh?: boolean;
  /** Refuse inputs that answer a `secret` prompt (an agent caller must never carry a credential). */
  noSecretInputs?: boolean;
  /** Leave a partially applied install in place instead of rolling the journal back. */
  keepPartial?: boolean;
  /** Skip the clean-working-tree precondition a refresh has (tests, scratch roots). */
  allowDirty?: boolean;
  /** Command runner; defaults to a shell in `root`. */
  exec?: ApplyOptions['exec'];
}

const skillsRoot = (root: string) => path.join(root, '.claude', 'skills');
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function readSkillMarkdown(root: string, name: string): { dir: string; md: string } {
  assertSkillName(name);
  const dir = path.join(skillsRoot(root), name);
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`unknown skill "${name}" — no .claude/skills/${name}/SKILL.md`);
  return { dir, md: readFileSync(file, 'utf8') };
}

/**
 * The frontmatter `description`, read with the YAML parser. Empty when absent
 * or unparseable — one hand-edited skill must not hide the whole catalog.
 */
function frontmatterDescription(md: string): string {
  const lines = md.split(/\r?\n/);
  if (lines[0] !== '---') return '';
  const close = lines.indexOf('---', 1);
  if (close === -1) return '';
  try {
    const parsed: unknown = parseYaml(lines.slice(1, close).join('\n'));
    return isPlainObject(parsed) && typeof parsed.description === 'string' ? parsed.description.trim() : '';
  } catch {
    return '';
  }
}

const isPrompt = (d: Directive) => d.kind === 'prompt';
const runEffect = (d: Directive): string | undefined =>
  d.kind === 'run' && typeof d.attrs.effect === 'string' ? d.attrs.effect : undefined;

/** The caller-owned effects a skill declares — what `list` and `plan` report, and an apply hands back instead of running. */
function callerOwnedEffects(directives: Directive[]): string[] {
  const declared = new Set(directives.map(runEffect));
  return CALLER_OWNED_EFFECTS.filter((effect) => declared.has(effect));
}

function inferKind(directives: Directive[], installedKind?: SkillKind): SkillKind {
  if (installedKind) return installedKind;
  const branches = registryBranches(directives);
  if (branches.includes('channels')) return 'channel';
  if (branches.includes('providers')) return 'provider';
  return 'other';
}

/** Every fence-carrying skill in the checkout — the ones the engine can apply. */
export function listSkills(root: string): SkillSummary[] {
  const dir = skillsRoot(root);
  if (!existsSync(dir)) return [];
  const installed = new Map(detectInstalledSkills(root).map((s) => [s.skillName, s.kind as SkillKind]));
  const out: SkillSummary[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!existsSync(file)) continue;
    const md = readFileSync(file, 'utf8');
    const directives = parseDirectives(md);
    if (directives.length === 0) continue;
    out.push({
      name,
      description: frontmatterDescription(md),
      kind: inferKind(directives, installed.get(name)),
      installed: installed.has(name),
      prompts: directives.filter(isPrompt).length,
      secretPrompts: directives.filter(isSecretPrompt).length,
      callerOwnedEffects: callerOwnedEffects(directives),
    });
  }
  return out;
}

function promptSummaries(directives: Directive[]): SkillPromptSummary[] {
  return directives.filter(isPrompt).map((d) => ({ var: promptVar(d) ?? '?', ...promptMeta(d) }));
}

/** What an apply would do, without writing anything. */
export function planHeadless(root: string, name: string): SkillPlan {
  const { dir, md } = readSkillMarkdown(root, name);
  const directives = parseDirectives(md);
  const plan = planSkill(dir, root);
  return {
    skill: name,
    steps: plan.steps,
    prompts: promptSummaries(directives),
    needsInput: plan.needsInput,
    agentSteps: plan.agentSteps,
    callerOwnedEffects: callerOwnedEffects(directives),
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/** `git status --porcelain`, or null when `root` is not a git work tree. */
function porcelain(root: string): string | null {
  try {
    return git(root, ['status', '--porcelain']);
  } catch {
    return null;
  }
}

/**
 * One apply per checkout, across processes. The setup wizard, /update-skills,
 * a terminal run, and `ncl skills apply` all write the same tree, and two
 * engines at once would build twice and roll back each other's journals. The
 * lock is a file in the OS temp dir named for the checkout — never inside the
 * tree, so it cannot dirty it — holding the owner's pid; a lock whose owner is
 * gone is stale and taken over.
 */
export function applyLockPath(root: string): string {
  const key = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `nanoclaw-skill-apply-${key}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // alive, owned by another user
  }
}

export function acquireApplyLock(root: string): { release: () => void } | { heldBy: number } {
  const file = applyLockPath(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release: () => {
          try {
            unlinkSync(file);
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let owner = Number.NaN;
    try {
      owner = Number.parseInt(readFileSync(file, 'utf8'), 10);
    } catch {
      // released between our open and our read — try again
    }
    if (Number.isFinite(owner) && processAlive(owner)) return { heldBy: owner };
    try {
      unlinkSync(file); // stale: its owner is gone
    } catch {
      // the owner released it first
    }
  }
  return { heldBy: 0 };
}

function report(
  skill: string,
  status: SkillApplyReport['status'],
  res?: ApplyResult,
  error?: string,
): SkillApplyReport {
  return {
    schema: SKILL_APPLY_SCHEMA,
    skill,
    status,
    applied: res?.applied ?? [],
    skipped: res?.skipped ?? [],
    deferred: res?.deferred ?? [],
    agentTasks: res?.agentTasks.map(({ kind, line, reason }) => ({ kind, line, reason })) ?? [],
    operatorMessages: res?.operatorMessages ?? [],
    vars: res?.vars ?? {},
    pendingEffects: res?.callerOwned ?? [],
    failure: res ? firstFailureHint(res) : undefined,
    error,
  };
}

const failed = (skill: string, error: string): SkillApplyReport => report(skill, 'failed', undefined, error);

/**
 * Apply one skill headlessly. Preconditions (a structured skill, no secret
 * inputs when forbidden, a clean tree for a refresh, no other apply on this
 * checkout) fail before any write. An install that does not fully apply is
 * rolled back through the engine's journal unless `keepPartial` is set, so the
 * tree is never left half-installed by accident. A refresh is never rolled
 * back: its journal records overwrites of files that were already installed,
 * and undoing those would delete them.
 */
export async function applyHeadless(
  root: string,
  name: string,
  opts: ApplyHeadlessOptions = {},
): Promise<SkillApplyReport> {
  const { dir, md } = readSkillMarkdown(root, name);
  const directives = parseDirectives(md);
  if (directives.length === 0) {
    return failed(name, 'skill has no structured apply directives — it needs a coding agent to apply its prose');
  }

  if (opts.refresh && !opts.allowDirty) {
    const status = porcelain(root);
    if (status === null) return failed(name, `${root} is not a git work tree; pass --allow-dirty to refresh anyway`);
    if (status) {
      return failed(
        name,
        'a refresh overwrites installed files, so the working tree must be clean first (commit or stash)',
      );
    }
  }

  const inputs = opts.inputs ?? {};
  if (opts.noSecretInputs) {
    const secret = new Set(directives.filter(isSecretPrompt).map((d) => promptVar(d) ?? ''));
    const offending = Object.keys(inputs).filter((k) => secret.has(k));
    if (offending.length > 0) {
      return failed(
        name,
        `secret inputs are refused on this path: ${offending.join(', ')} — credentials are entered by the operator on the host, never relayed through chat`,
      );
    }
  }

  const lock = acquireApplyLock(root);
  if ('heldBy' in lock) {
    const who = lock.heldBy > 0 ? ` (pid ${lock.heldBy})` : '';
    return failed(name, `another skill apply is running on this checkout${who} — wait for it to finish`);
  }
  try {
    const exec = opts.exec ?? hostShellExec(root);
    let bunOnHost: boolean | undefined; // probed only if a dependency fence asks for Bun, and only once
    const remotes: Record<string, string> = {}; // one ls-remote per registry branch
    const res = await applySkill(dir, root, {
      mode: opts.refresh ? 'refresh' : 'install',
      inputs,
      exec,
      skipEffects: [...CALLER_OWNED_EFFECTS],
      resolveDependencyCommand: (request) => {
        if (request.manager === 'bun') bunOnHost ??= commandAvailable('bun', root);
        return portableDependencyCommand(root, bunOnHost ?? false, request);
      },
      resolveRemote: (branch) => (remotes[branch] ??= resolveRegistryRemote(root, branch)),
    });

    if (fullyApplied(res)) return report(name, 'applied', res);
    if (opts.refresh) {
      return report(
        name,
        'failed',
        res,
        'the refresh stopped part-way; files re-copied so far were left in place (a refresh is never rolled back)',
      );
    }
    if (opts.keepPartial) return report(name, 'failed', res);
    try {
      await removeSkill(root, res.journal, async (cmd) => void (await exec(cmd)));
    } catch (err) {
      return report(
        name,
        'failed',
        res,
        `rollback failed: ${errMsg(err)} — the tree may be partially undone; inspect it before retrying`,
      );
    }
    return report(name, 'rolled-back', res);
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Cli = ApplyHeadlessOptions & { command: string; skill?: string; root: string };

export function parseCli(argv: string[]): Cli {
  const [command = '', ...rest] = argv;
  const cli: Cli = { command, root: process.cwd() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--root':
        cli.root = path.resolve(rest[++i] ?? '');
        break;
      case '--inputs': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rest[++i] ?? '');
        } catch {
          parsed = undefined;
        }
        if (!isPlainObject(parsed)) throw new Error('--inputs must be a JSON object of prompt var → value');
        cli.inputs = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        break;
      }
      case '--refresh':
        cli.refresh = true;
        break;
      case '--no-secret-inputs':
        cli.noSecretInputs = true;
        break;
      case '--keep-partial':
        cli.keepPartial = true;
        break;
      case '--allow-dirty':
        cli.allowDirty = true;
        break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
        if (cli.skill !== undefined) throw new Error(`unexpected argument ${a}`);
        cli.skill = a;
    }
  }
  return cli;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  let out: unknown;
  let ok = true;
  switch (cli.command) {
    case 'list':
      out = listSkills(cli.root);
      break;
    case 'plan':
      if (!cli.skill) throw new Error('plan needs a skill name');
      out = planHeadless(cli.root, cli.skill);
      break;
    case 'apply': {
      if (!cli.skill) throw new Error('apply needs a skill name');
      const report = await applyHeadless(cli.root, cli.skill, cli);
      out = report;
      ok = report.status === 'applied';
      break;
    }
    default:
      throw new Error('usage: skill-headless.ts list | plan <skill> | apply <skill> [flags]');
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ schema: SKILL_APPLY_SCHEMA, error: errMsg(err) })}\n`);
    process.exitCode = 1;
  });
}
