import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultTransactionsRoot, type UpdateState } from '../../../../scripts/update/transaction.js';
import {
  CONFIG_PATH,
  RESULT_PATH,
  acquireLock,
  agentCommand,
  defaultDeps,
  listTransactions,
  parseConfig,
  runScheduledUpdate,
  runWithTimeout,
  settleAction,
  type Deps,
  type ExecResult,
} from './scheduled-update.js';

// Each case builds real git repositories; the default 5s is too tight on a busy machine.
const GIT_FIXTURE_TIMEOUT_MS = 30_000;
const temps: string[] = [];
const savedUpdateDir = process.env.NANOCLAW_UPDATE_DIR;

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, content: string): void {
  fs.writeFileSync(path.join(cwd, file), content);
  sh(cwd, 'add', file);
  sh(cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', file);
}

/** A project clone with an `upstream` remote that is `ahead` commits in front of it. */
function project(ahead: number): string {
  const upstream = tempDir('sched-upstream-');
  sh(upstream, 'init', '-q', '-b', 'main');
  commit(upstream, 'README.md', 'base\n');
  const root = tempDir('sched-project-');
  execFileSync('git', ['clone', '-q', '-o', 'upstream', upstream, root]);
  sh(root, 'config', 'user.name', 't');
  sh(root, 'config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(root, '.gitignore'), 'logs/\n.nanoclaw/\n');
  sh(root, 'add', '.gitignore');
  sh(root, 'commit', '-q', '-m', 'ignore');
  for (let i = 0; i < ahead; i += 1) commit(upstream, `up-${i}.txt`, `${i}\n`);
  process.env.NANOCLAW_UPDATE_DIR = tempDir('sched-updates-');
  return root;
}

function writeConfig(root: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, '.nanoclaw'), { recursive: true });
  fs.writeFileSync(path.join(root, CONFIG_PATH), JSON.stringify(config));
}

/** A state file the real controller's loadState accepts. */
function writeState(root: string, id: string, fields: Partial<UpdateState>): void {
  const transactionRoot = path.join(defaultTransactionsRoot(root), id);
  fs.mkdirSync(transactionRoot, { recursive: true });
  const state: UpdateState = {
    schema: 'nanoclaw-update/v1',
    id,
    phase: 'prepared',
    projectRoot: root,
    transactionRoot,
    stageRoot: path.join(transactionRoot, 'worktree'),
    stageBranch: `update-nanoclaw/${id}`,
    upstreamRef: 'upstream/main',
    strategy: 'merge',
    originalHead: 'a'.repeat(40),
    backupBranch: 'backup/pre-update-abcdef12-20260101000000-abcdef12',
    backupTag: 'pre-update-abcdef12-20260101000000-abcdef12',
    changedFiles: [],
    requirements: [],
    createdAt: new Date().toISOString(),
    ...fields,
  };
  fs.writeFileSync(path.join(transactionRoot, 'state.json'), JSON.stringify(state));
}

interface Harness {
  deps: Deps;
  calls: string[][];
  agentRuns: string[][];
}

/** Real git; controller, upgrade-state and ncl calls recorded and answered by `onCommand`. */
function harness(
  onAgent: () => void = () => {},
  onCommand: (args: string[]) => ExecResult | undefined = () => undefined,
): Harness {
  const calls: string[][] = [];
  const agentRuns: string[][] = [];
  return {
    calls,
    agentRuns,
    deps: {
      exec(cmd, args, cwd) {
        if (cmd === 'git') return defaultDeps.exec(cmd, args, cwd);
        const call = [path.basename(cmd), ...args];
        calls.push(call);
        return onCommand(call) ?? { ok: true, stdout: '', stderr: '' };
      },
      async runAgent(argv) {
        agentRuns.push(argv);
        onAgent();
        return { exitCode: 0, timedOut: false };
      },
    },
  };
}

function readResult(root: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(root, RESULT_PATH), 'utf8'));
}

beforeEach(() => {
  delete process.env.NANOCLAW_UPDATE_DIR;
});

afterEach(() => {
  if (savedUpdateDir === undefined) delete process.env.NANOCLAW_UPDATE_DIR;
  else process.env.NANOCLAW_UPDATE_DIR = savedUpdateDir;
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('config', () => {
  it('defaults to refusing a dirty tree and the CLI default model', () => {
    expect(parseConfig({ agent: 'claude' })).toEqual({
      agent: 'claude',
      model: undefined,
      timeoutMinutes: 120,
      dirtyTree: 'refuse',
      reporterTask: undefined,
      reporterGroup: undefined,
    });
  });

  it('rejects unknown agents, bad timeouts, and a reporter group without a task', () => {
    expect(() => parseConfig({ agent: 'other' })).toThrow(/agent/);
    expect(() => parseConfig({ agent: 'codex', timeoutMinutes: 0 })).toThrow(/timeoutMinutes/);
    expect(() => parseConfig({ agent: 'codex', dirtyTree: 'force' })).toThrow(/dirtyTree/);
    expect(() => parseConfig({ agent: 'codex', reporterGroup: 'g' })).toThrow(/reporterTask/);
  });

  it('passes a model flag only when one is configured', () => {
    expect(agentCommand(parseConfig({ agent: 'claude' }), 'P')).toEqual([
      'claude',
      '-p',
      'P',
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(agentCommand(parseConfig({ agent: 'codex', model: 'm' }), 'P')).toEqual([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '-m',
      'm',
      'P',
    ]);
    expect(agentCommand(parseConfig({ agent: 'opencode', model: 'p/m' }), 'P')).toEqual([
      'opencode',
      'run',
      '--auto',
      '-m',
      'p/m',
      'P',
    ]);
  });
});

describe('lock', () => {
  it('refuses a live holder and takes over a dead one', () => {
    const lock = path.join(tempDir('sched-lock-'), 'run.lock');
    expect(acquireLock(lock)).toBe(true);
    expect(acquireLock(lock)).toBe(false);

    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    }).stdout;
    fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead) }));
    expect(acquireLock(lock)).toBe(true);
  });
});

describe('timeout', () => {
  it('kills the whole process group once the deadline passes', async () => {
    const dir = tempDir('sched-timeout-');
    const started = Date.now();
    const outcome = await runWithTimeout(['sh', '-c', 'sleep 30 & sleep 30'], {
      cwd: dir,
      timeoutMs: 200,
      logFile: path.join(dir, 'agent.log'),
    });
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('controller transactions', { timeout: GIT_FIXTURE_TIMEOUT_MS }, () => {
  it('reads real controller state and settles by whether cutover touched the live checkout', () => {
    const root = project(0);
    writeState(root, 'done', { phase: 'complete', createdAt: '2026-01-01T00:00:00.000Z' });
    writeState(root, 'staged', { phase: 'validated' });
    writeState(root, 'interrupted', { phase: 'validated', snapshot: [] });
    writeState(root, 'cut', { phase: 'cutover', snapshot: [] });
    fs.mkdirSync(path.join(defaultTransactionsRoot(root), 'not-a-transaction'));

    const byId = Object.fromEntries(listTransactions(root).map((state) => [state.id, settleAction(state)]));
    expect(byId).toEqual({ done: undefined, staged: 'abandon', interrupted: 'rollback', cut: 'rollback' });
  });
});

describe('runScheduledUpdate', { timeout: GIT_FIXTURE_TIMEOUT_MS }, () => {
  it('refuses a dirty tree by default without running the agent, and wakes the reporter', async () => {
    const root = project(2);
    writeConfig(root, { agent: 'claude', reporterTask: 'report-task', reporterGroup: 'group-1' });
    fs.writeFileSync(path.join(root, 'README.md'), 'local edit\n');
    const h = harness();

    const result = await runScheduledUpdate(root, h.deps);

    expect(result?.status).toBe('blocked');
    expect(result?.detail).toContain('README.md');
    expect(h.agentRuns).toEqual([]);
    expect(h.calls).toEqual([
      [
        'ncl',
        'tasks',
        'append-log',
        '--id',
        'report-task',
        '--group',
        'group-1',
        '--msg',
        expect.stringContaining('blocked'),
      ],
      ['ncl', 'tasks', 'run', '--id', 'report-task', '--group', 'group-1'],
    ]);
    expect(fs.existsSync(path.join(root, 'logs/scheduled-update.lock'))).toBe(false);
  });

  it('commits a dirty tree and re-stamps the upgrade marker when opted in', async () => {
    const root = project(0);
    writeConfig(root, { agent: 'claude', dirtyTree: 'commit' });
    fs.writeFileSync(path.join(root, 'README.md'), 'local edit\n');
    const before = sh(root, 'rev-parse', 'HEAD');
    const h = harness();

    const result = await runScheduledUpdate(root, h.deps);

    expect(result?.status).toBe('up-to-date');
    expect(sh(root, 'rev-parse', 'HEAD^')).toBe(before);
    expect(sh(root, 'status', '--porcelain')).toBe('');
    expect(h.calls).toContainEqual(['pnpm', 'exec', 'tsx', 'scripts/upgrade-state.ts', 'set']);
  });

  it('skips the agent when upstream has nothing pending', async () => {
    const root = project(0);
    writeConfig(root, { agent: 'codex' });
    const h = harness();

    expect((await runScheduledUpdate(root, h.deps))?.status).toBe('up-to-date');
    expect(h.agentRuns).toEqual([]);
  });

  it('blocks while an earlier transaction is still open', async () => {
    const root = project(1);
    writeConfig(root, { agent: 'claude' });
    writeState(root, 'earlier', { phase: 'conflict' });
    const h = harness();

    const result = await runScheduledUpdate(root, h.deps);
    expect(result?.status).toBe('blocked');
    expect(result?.transaction).toEqual({ id: 'earlier', phase: 'conflict' });
    expect(h.agentRuns).toEqual([]);
  });

  it('rolls back a transaction the agent left after cutover began', async () => {
    const root = project(3);
    writeConfig(root, { agent: 'claude', model: 'some-model', timeoutMinutes: 5 });
    const h = harness(
      () => writeState(root, 'left-open', { phase: 'cutover', snapshot: [] }),
      (call) => {
        if (call.includes('rollback')) writeState(root, 'left-open', { phase: 'rolled-back', snapshot: [] });
        return undefined;
      },
    );

    const result = await runScheduledUpdate(root, h.deps);

    expect(h.agentRuns[0]).toEqual(expect.arrayContaining(['claude', '--model', 'some-model']));
    expect(h.agentRuns[0].join(' ')).toContain('3 upstream commit(s)');
    expect(h.calls).toContainEqual([
      'pnpm',
      'exec',
      'tsx',
      'scripts/update-nanoclaw.ts',
      'rollback',
      '--project-root',
      root,
      '--id',
      'left-open',
    ]);
    expect(result).toMatchObject({
      status: 'rolled-back',
      pendingCommits: 3,
      transaction: { id: 'left-open', phase: 'rolled-back', settledBy: 'rollback' },
      serviceHealthy: true,
    });
    expect(readResult(root).status).toBe('rolled-back');
  });

  it('reports a completed controller transaction as updated without touching it', async () => {
    const root = project(1);
    writeConfig(root, { agent: 'opencode' });
    const h = harness(() => writeState(root, 'good', { phase: 'complete' }));

    const result = await runScheduledUpdate(root, h.deps);
    expect(result?.status).toBe('updated');
    expect(h.calls.some((call) => call.includes('rollback') || call.includes('abandon'))).toBe(false);
  });

  it('fails when the agent never starts a transaction', async () => {
    const root = project(1);
    writeConfig(root, { agent: 'claude' });

    const result = await runScheduledUpdate(root, harness().deps);
    expect(result?.status).toBe('failed');
    expect(result?.detail).toMatch(/without starting an update/);
  });
});
