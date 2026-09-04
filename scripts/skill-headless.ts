#!/usr/bin/env tsx
// Headless skill engine entry: list / plan / apply, JSON in and out.
//
// The consumer of the skill-engine seam for callers with no human at a TTY —
// `ncl skills` on the host (an agent's request, held for admin approval) and
// pipelines. The prose in each SKILL.md stays authoritative: anything the
// engine cannot do deterministically is reported as an agent task, never
// improvised. Failed code steps roll back through the engine's journal;
// missing inputs and operator-owned setup leave the installed code pending.
//
// Usage (always prints one JSON document to stdout):
//   pnpm exec tsx scripts/skill-headless.ts list [--root <dir>]
//   pnpm exec tsx scripts/skill-headless.ts plan <skill> [--root <dir>]
//   pnpm exec tsx scripts/skill-headless.ts apply <skill> [--root <dir>] [--inputs <json>]
//        [--refresh] [--no-secret-inputs]
//
// Exit code 0 for list, plan, or a fully applied skill; 1 for failure or pending
// operator setup — the JSON distinguishes them.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CALLER_OWNED_EFFECTS,
  SKILL_APPLY_SCHEMA,
  assertSkillName,
  errorMessage,
  isPlainObject,
  parseFrontmatter,
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
  type ApplyOptions,
  type ApplyResult,
} from './skill-apply.js';
import { isSecretPrompt, parseDirectives, promptVar, registryBranches, type Directive } from './skill-directives.js';
import { sourceInstallRefusal } from '../src/cli/source-install.js';
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
  /** Command runner; defaults to a shell in `root`. */
  exec?: ApplyOptions['exec'];
}

const skillsRoot = (root: string) => path.join(root, '.claude', 'skills');
// External commands can open auth flows or mutate system state. A headless
// consumer cannot complete or roll back those; the terminal driver owns them.
const HEADLESS_EFFECTS = [...CALLER_OWNED_EFFECTS, 'external'];

function readSkillMarkdown(root: string, name: string): { dir: string; md: string } {
  assertSkillName(name);
  const dir = path.join(skillsRoot(root), name);
  const file = path.join(dir, 'SKILL.md');
  if (!existsSync(file)) throw new Error(`unknown skill "${name}" — no .claude/skills/${name}/SKILL.md`);
  return { dir, md: readFileSync(file, 'utf8') };
}

/** The frontmatter `description`; empty when absent or unparseable — one hand-edited skill must not hide the catalog. */
function frontmatterDescription(md: string): string {
  const description = parseFrontmatter(md)?.description;
  return typeof description === 'string' ? description.trim() : '';
}

const isPrompt = (d: Directive) => d.kind === 'prompt';
const runEffect = (d: Directive): string | undefined =>
  d.kind === 'run' && typeof d.attrs.effect === 'string' ? d.attrs.effect : undefined;

/** The caller-owned effects a skill declares — what `list` and `plan` report, and an apply hands back instead of running. */
function callerOwnedEffects(directives: Directive[]): string[] {
  const declared = new Set(directives.map(runEffect));
  return HEADLESS_EFFECTS.filter((effect) => declared.has(effect));
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

export { applyLockPath } from './skill-lock.js';

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
 * checkout) fail before any write. Failed code steps are rolled back through
 * the engine's journal. Missing inputs and caller-owned setup are reported as
 * needs-setup; the operator finishes the reported steps from the skill. A refresh
 * is never rolled back: its journal records
 * overwrites of files that were already installed, and undoing those would
 * delete them.
 */
export async function applyHeadless(
  root: string,
  name: string,
  opts: ApplyHeadlessOptions = {},
): Promise<SkillApplyReport> {
  const refusal = sourceInstallRefusal(root);
  if (refusal) return failed(name, refusal);
  const { dir, md } = readSkillMarkdown(root, name);
  const directives = parseDirectives(md);
  if (directives.length === 0) {
    return failed(name, 'skill has no structured apply directives — it needs a coding agent to apply its prose');
  }

  if (opts.refresh) {
    const status = porcelain(root);
    if (status === null)
      return failed(name, `${root} is not a git work tree — a refresh needs one to protect uncommitted edits`);
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

  try {
    const exec = opts.exec ?? hostShellExec(root);
    let bunOnHost: boolean | undefined; // probed only if a dependency fence asks for Bun, and only once
    const remotes: Record<string, string> = {}; // one ls-remote per registry branch
    const res = await applySkill(dir, root, {
      mode: opts.refresh ? 'refresh' : 'install',
      rollbackOnFailure: !opts.refresh,
      inputs,
      exec,
      skipEffects: HEADLESS_EFFECTS,
      resolveDependencyCommand: (request) => {
        if (request.manager === 'bun') bunOnHost ??= commandAvailable('bun', root);
        return portableDependencyCommand(root, bunOnHost ?? false, request);
      },
      resolveRemote: (branch) => (remotes[branch] ??= resolveRegistryRemote(root, branch)),
    });

    if (res.agentTasks.length === 0) {
      const pending = !fullyApplied(res) || res.callerOwned.some((step) => step.effect !== 'restart');
      return report(name, pending ? 'needs-setup' : 'applied', res);
    }
    if (opts.refresh) {
      return report(
        name,
        'failed',
        res,
        'the refresh stopped part-way; files re-copied so far were left in place (a refresh is never rolled back)',
      );
    }
    if (res.rollback?.error) {
      return report(name, 'failed', res, `rollback failed: ${res.rollback.error} — inspect the tree before retrying`);
    }
    return report(name, 'rolled-back', res);
  } catch (err) {
    return failed(name, errorMessage(err));
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
    process.stdout.write(`${JSON.stringify({ schema: SKILL_APPLY_SCHEMA, error: errorMessage(err) })}\n`);
    process.exitCode = 1;
  });
}
