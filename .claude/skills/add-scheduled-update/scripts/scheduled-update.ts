/**
 * Unattended host-side runner for /update-nanoclaw, started by a launchd job
 * or systemd timer. It owns everything around the update — lock, dirty-tree
 * policy, pending check, timeout, outcome — and hands the update itself to a
 * headless coding agent that drives scripts/update-nanoclaw.ts.
 *
 * The runner never leaves a transaction it started half-done: after the agent
 * exits (or is killed), a transaction that reached the live checkout is rolled
 * back through the controller, and one that did not is abandoned.
 *
 * Usage (from the project root):
 *   pnpm exec tsx .claude/skills/add-scheduled-update/scripts/scheduled-update.ts [run]
 *   pnpm exec tsx .claude/skills/add-scheduled-update/scripts/scheduled-update.ts label
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getInstallSlug } from '../../../../src/install-slug.js';
import { defaultTransactionsRoot, loadState, type UpdateState } from '../../../../scripts/update/transaction.js';

export const CONFIG_PATH = '.nanoclaw/scheduled-update.json';
export const LOG_PATH = 'logs/scheduled-update.log';
export const AGENT_LOG_PATH = 'logs/scheduled-update.agent.log';
export const RESULT_PATH = 'logs/scheduled-update.last.json';
export const LOCK_PATH = 'logs/scheduled-update.lock';

const AGENTS = ['claude', 'codex', 'opencode'] as const;
const DIRTY_POLICIES = ['refuse', 'commit'] as const;
const TERMINAL_PHASES: ReadonlySet<UpdateState['phase']> = new Set(['complete', 'rolled-back', 'abandoned']);
const KILL_GRACE_MS = 30_000;

export interface ScheduledUpdateConfig {
  agent: (typeof AGENTS)[number];
  model?: string;
  timeoutMinutes: number;
  dirtyTree: (typeof DIRTY_POLICIES)[number];
  reporterTask?: string;
  reporterGroup?: string;
}

export type RunStatus = 'up-to-date' | 'blocked' | 'updated' | 'rolled-back' | 'abandoned' | 'failed';

export interface RunResult {
  schema: 'nanoclaw-scheduled-update/v1';
  status: RunStatus;
  detail: string;
  startedAt: string;
  finishedAt: string;
  headBefore: string;
  headAfter: string;
  pendingCommits?: number;
  transaction?: { id: string; phase: string; settledBy?: 'rollback' | 'abandon' };
  agent?: { exitCode: number | null; timedOut: boolean };
  serviceHealthy?: boolean;
}

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface AgentOutcome {
  exitCode: number | null;
  timedOut: boolean;
}

export interface Deps {
  exec(cmd: string, args: string[], cwd: string): ExecResult;
  runAgent(argv: string[], opts: { cwd: string; timeoutMs: number; logFile: string }): Promise<AgentOutcome>;
}

export function parseConfig(raw: unknown): ScheduledUpdateConfig {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const value = raw as Record<string, unknown>;
  const agent = value.agent;
  if (typeof agent !== 'string' || !(AGENTS as readonly string[]).includes(agent)) {
    throw new Error(`config.agent must be one of ${AGENTS.join(', ')}`);
  }
  const model = value.model;
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw new Error('config.model must be a non-empty string when set');
  }
  const timeoutMinutes = value.timeoutMinutes ?? 120;
  if (typeof timeoutMinutes !== 'number' || !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    throw new Error('config.timeoutMinutes must be a positive number');
  }
  const dirtyTree = value.dirtyTree ?? 'refuse';
  if (typeof dirtyTree !== 'string' || !(DIRTY_POLICIES as readonly string[]).includes(dirtyTree)) {
    throw new Error(`config.dirtyTree must be one of ${DIRTY_POLICIES.join(', ')}`);
  }
  for (const key of ['reporterTask', 'reporterGroup'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !(value[key] as string).trim())) {
      throw new Error(`config.${key} must be a non-empty string when set`);
    }
  }
  if (value.reporterGroup !== undefined && value.reporterTask === undefined) {
    throw new Error('config.reporterGroup requires config.reporterTask');
  }
  return {
    agent: agent as ScheduledUpdateConfig['agent'],
    model: model as string | undefined,
    timeoutMinutes,
    dirtyTree: dirtyTree as ScheduledUpdateConfig['dirtyTree'],
    reporterTask: value.reporterTask as string | undefined,
    reporterGroup: value.reporterGroup as string | undefined,
  };
}

/** Headless, permission-bypassing invocation per CLI. No model flag means the CLI's own default. */
export function agentCommand(config: ScheduledUpdateConfig, prompt: string): string[] {
  const model = config.model;
  if (config.agent === 'claude') {
    return ['claude', '-p', prompt, '--permission-mode', 'bypassPermissions', ...(model ? ['--model', model] : [])];
  }
  if (config.agent === 'codex') {
    return ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', ...(model ? ['-m', model] : []), prompt];
  }
  return ['opencode', 'run', '--auto', ...(model ? ['-m', model] : []), prompt];
}

export function updatePrompt(pending: number, upstreamRef: string): string {
  return `Update this NanoClaw install by following the update-nanoclaw skill at
.claude/skills/update-nanoclaw/SKILL.md, end to end: prepare (merge strategy, ${upstreamRef}),
resolve any conflicts inside the staging worktree only, validate, cutover, complete every
requirement, finish, cleanup. ${pending} upstream commit(s) are pending.

This is an unattended run the operator scheduled on the host:
- The schedule is the operator's cutover confirmation. Do not ask for confirmation; nobody will answer.
- This is one non-interactive turn. Run every command in the foreground and wait for it, however
  long it takes. Never background a step or wait for a later notification.
- Never run the prune command. Never push. Never reset, restore, stash, clean or check out files in
  the live checkout; the controller is the only thing that changes it.
- Preserve intentional local customizations when resolving conflicts.
- If validation fails for a reason the update did not cause, or a requirement cannot be verified,
  abandon (before cutover) or acknowledge it as failed (after cutover). Never force a step through.

End your final message with one line: OUTCOME: <updated|abandoned|rolled-back|blocked> — <one sentence>.`;
}

function defaultExec(cmd: string, args: string[], cwd: string): ExecResult {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`,
  };
}

/** Runs a command in its own process group so a timeout kills the agent and every child it spawned. */
export function runWithTimeout(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; logFile: string },
): Promise<AgentOutcome> {
  return new Promise((resolve) => {
    const log = fs.openSync(opts.logFile, 'w');
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, detached: true, stdio: ['ignore', log, log] });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // group already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) signalGroup('SIGKILL');
      fs.closeSync(log);
      resolve({ exitCode, timedOut });
    };
    child.on('error', (err) => {
      fs.appendFileSync(opts.logFile, `${String(err)}\n`);
      done(null);
    });
    child.on('exit', (code) => done(code));
  });
}

export const defaultDeps: Deps = { exec: defaultExec, runAgent: runWithTimeout };

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Exclusive lock holding the owner's pid. A lock left by a dead process is taken over. */
export function acquireLock(lockFile: string): boolean {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
        flag: 'wx',
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let pid = NaN;
      try {
        pid = Number((JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: unknown }).pid);
      } catch {
        // unreadable lock: treat as stale
      }
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return false;
      fs.rmSync(lockFile, { force: true });
    }
  }
  return false;
}

export function releaseLock(lockFile: string): void {
  fs.rmSync(lockFile, { force: true });
}

/** Every transaction the controller can load for this checkout, newest first. */
export function listTransactions(projectRoot: string): UpdateState[] {
  const root = defaultTransactionsRoot(fs.realpathSync(projectRoot));
  if (!fs.existsSync(root)) return [];
  const states: UpdateState[] = [];
  for (const id of fs.readdirSync(root)) {
    try {
      states.push(loadState(projectRoot, id));
    } catch {
      // not a transaction directory, or unsafe state the controller would refuse too
    }
  }
  return states.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** A snapshot means cutover began touching the live checkout, even if the phase never advanced. */
export function settleAction(state: UpdateState): 'rollback' | 'abandon' | undefined {
  if (TERMINAL_PHASES.has(state.phase)) return undefined;
  return state.snapshot ? 'rollback' : 'abandon';
}

function describe(result: ExecResult): string {
  return `${result.stdout}${result.stderr}`.trim();
}

/** stdout with trailing whitespace removed; leading whitespace is significant in porcelain output. */
function git(deps: Deps, root: string, args: string[]): string {
  const result = deps.exec('git', args, root);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${describe(result)}`);
  return result.stdout.trimEnd();
}

export function resolveUpstreamRef(deps: Deps, root: string): { remote: string; ref: string } | undefined {
  let remote: string | undefined;
  if (deps.exec('git', ['remote', 'get-url', 'upstream'], root).ok) remote = 'upstream';
  else {
    const origin = deps.exec('git', ['remote', 'get-url', 'origin'], root);
    if (origin.ok && /(^|[:/])nanocoai\/nanoclaw(\.git)?$/.test(origin.stdout.trim())) remote = 'origin';
  }
  if (!remote) return undefined;
  const fetched = deps.exec('git', ['fetch', remote, '--prune'], root);
  if (!fetched.ok) throw new Error(`git fetch ${remote} failed: ${describe(fetched)}`);
  for (const branch of ['main', 'master']) {
    if (deps.exec('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], root).ok) {
      return { remote, ref: `${remote}/${branch}` };
    }
  }
  return undefined;
}

export async function runScheduledUpdate(projectRoot: string, deps: Deps = defaultDeps): Promise<RunResult | null> {
  const root = fs.realpathSync(projectRoot);
  const at = (rel: string) => path.join(root, rel);
  fs.mkdirSync(at('logs'), { recursive: true });
  const log = (line: string) => fs.appendFileSync(at(LOG_PATH), `${new Date().toISOString()}  ${line}\n`);

  if (!acquireLock(at(LOCK_PATH))) {
    log('another scheduled update holds the lock; exiting');
    return null;
  }
  const startedAt = new Date().toISOString();
  const head = () => deps.exec('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const headBefore = head();
  let config: ScheduledUpdateConfig | undefined;
  const finish = (partial: Omit<RunResult, 'schema' | 'startedAt' | 'finishedAt' | 'headBefore' | 'headAfter'>) => {
    const result: RunResult = {
      schema: 'nanoclaw-scheduled-update/v1',
      startedAt,
      finishedAt: new Date().toISOString(),
      headBefore,
      headAfter: head(),
      ...partial,
    };
    fs.writeFileSync(at(RESULT_PATH), `${JSON.stringify(result, null, 2)}\n`);
    log(`result: ${result.status} — ${result.detail}`);
    if (config?.reporterTask) notifyReporter(deps, root, config, result, log);
    return result;
  };

  try {
    try {
      config = parseConfig(JSON.parse(fs.readFileSync(at(CONFIG_PATH), 'utf8')));
    } catch (err) {
      return finish({ status: 'failed', detail: `invalid ${CONFIG_PATH}: ${(err as Error).message}` });
    }
    log(`run starting (agent ${config.agent}, model ${config.model ?? 'CLI default'})`);

    const open = listTransactions(root).find((state) => !TERMINAL_PHASES.has(state.phase));
    if (open) {
      return finish({
        status: 'blocked',
        detail: `update transaction ${open.id} is in phase ${open.phase}; finish or abandon it with /update-nanoclaw`,
        transaction: { id: open.id, phase: open.phase },
      });
    }

    const dirty = git(deps, root, ['status', '--porcelain']);
    if (dirty) {
      const files = dirty
        .split('\n')
        .map((line) => line.slice(3))
        .join(', ');
      if (config.dirtyTree === 'refuse') {
        return finish({ status: 'blocked', detail: `working tree has uncommitted changes: ${files}` });
      }
      git(deps, root, ['add', '-A']);
      git(deps, root, ['commit', '-q', '-m', 'chore: commit local changes before scheduled update']);
      if (git(deps, root, ['status', '--porcelain'])) {
        return finish({ status: 'failed', detail: 'working tree is still dirty after the pre-update commit' });
      }
      // The host refuses to start when HEAD no longer matches the upgrade marker.
      const stamp = deps.exec('pnpm', ['exec', 'tsx', 'scripts/upgrade-state.ts', 'set'], root);
      if (!stamp.ok) return finish({ status: 'failed', detail: `upgrade-state re-stamp failed: ${describe(stamp)}` });
      log(`committed local changes as ${git(deps, root, ['rev-parse', '--short', 'HEAD'])}: ${files}`);
    }

    const upstream = resolveUpstreamRef(deps, root);
    if (!upstream) {
      return finish({ status: 'blocked', detail: 'no official upstream remote; run /update-nanoclaw once by hand' });
    }
    const pendingCommits = Number(git(deps, root, ['rev-list', '--count', `HEAD..${upstream.ref}`]));
    if (pendingCommits === 0) return finish({ status: 'up-to-date', detail: `no commits pending on ${upstream.ref}` });

    log(`running ${config.agent} for ${pendingCommits} pending commit(s)`);
    const agent = await deps.runAgent(agentCommand(config, updatePrompt(pendingCommits, upstream.ref)), {
      cwd: root,
      timeoutMs: config.timeoutMinutes * 60_000,
      logFile: at(AGENT_LOG_PATH),
    });
    const agentNote = agent.timedOut
      ? `agent timed out after ${config.timeoutMinutes} min`
      : `agent exited ${agent.exitCode}`;

    const started = listTransactions(root).find((state) => Date.parse(state.createdAt) >= Date.parse(startedAt));
    if (!started) {
      return finish({ status: 'failed', detail: `${agentNote} without starting an update`, pendingCommits, agent });
    }
    let phase: string = started.phase;
    const settledBy = settleAction(started);
    if (settledBy) {
      log(`transaction ${started.id} left in ${phase}; running controller ${settledBy}`);
      const settled = deps.exec(
        'pnpm',
        ['exec', 'tsx', 'scripts/update-nanoclaw.ts', settledBy, '--project-root', root, '--id', started.id],
        root,
      );
      log(describe(settled));
      phase = loadState(root, started.id).phase;
    }
    const serviceHealthy = deps.exec(at('bin/ncl'), ['groups', 'list'], root).ok;
    const transaction = { id: started.id, phase, ...(settledBy ? { settledBy } : {}) };
    const status: RunStatus =
      phase === 'complete'
        ? 'updated'
        : phase === 'rolled-back'
          ? 'rolled-back'
          : phase === 'abandoned'
            ? 'abandoned'
            : 'failed';
    return finish({
      status,
      detail: `${agentNote}; transaction ${started.id} ended in ${phase}${settledBy ? ` after runner ${settledBy}` : ''}`,
      pendingCommits,
      transaction,
      agent,
      serviceHealthy,
    });
  } catch (err) {
    return finish({ status: 'failed', detail: (err as Error).message });
  } finally {
    releaseLock(at(LOCK_PATH));
  }
}

function notifyReporter(
  deps: Deps,
  root: string,
  config: ScheduledUpdateConfig,
  result: RunResult,
  log: (line: string) => void,
): void {
  const target = [
    '--id',
    config.reporterTask as string,
    ...(config.reporterGroup ? ['--group', config.reporterGroup] : []),
  ];
  const ncl = path.join(root, 'bin/ncl');
  const summary = `scheduled update: ${result.status} — ${result.detail} (details: ${RESULT_PATH})`;
  for (const args of [
    ['tasks', 'append-log', ...target, '--msg', summary],
    ['tasks', 'run', ...target],
  ]) {
    const outcome = deps.exec(ncl, args, root);
    if (!outcome.ok) log(`ncl ${args.slice(0, 2).join(' ')} failed: ${describe(outcome)}`);
  }
}

export function unitName(projectRoot: string): string {
  return `nanoclaw-scheduled-update-${getInstallSlug(projectRoot)}`;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  if (command === 'label') {
    process.stdout.write(`${unitName(fs.realpathSync(process.cwd()))}\n`);
    return;
  }
  if (command !== 'run') throw new Error(`Unknown command: ${command}`);
  if (!fs.existsSync(path.join(process.cwd(), 'scripts/update-nanoclaw.ts'))) {
    throw new Error('Run from the NanoClaw project root');
  }
  const result = await runScheduledUpdate(process.cwd());
  if (result && result.status !== 'up-to-date' && result.status !== 'updated') process.exitCode = 1;
}

function isMainModule(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(argv))).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
