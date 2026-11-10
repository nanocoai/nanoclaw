import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createUpdateRuntime,
  loadState,
  prepareUpdate,
  resumePreparedUpdate,
  validateUpdate,
  type UpdateState,
} from './transaction.js';
import type { CommandRunner } from './service.js';

const roots: string[] = [];
let previousUpdateDir: string | undefined;

function temp(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function commit(root: string, message: string): void {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
}

const manifest = (deps: string[]) =>
  `${JSON.stringify({ name: 'x', dependencies: Object.fromEntries(deps.map((d) => [d, '^1.0.0'])) })}\n`;
const lockfile = (entries: string[]) =>
  `lockfileVersion: '9.0'\n\npackages:\n${entries.map((e) => `  ${e}: {}\n`).join('')}`;

/**
 * Upstream bumps `c` within its range in the lockfile only (a security fix);
 * the install's setup commit adds `b` to the manifest and lockfile next to it.
 * Git cannot merge the two, though the manifests merge cleanly.
 */
function fixture(
  options: { bun?: boolean; markerSize?: { base?: number; upstream?: number }; otherConflict?: boolean } = {},
): { install: string } {
  const attributes = (size: number) => `pnpm-lock.yaml conflict-marker-size=${size}\n`;
  const seed = temp('lockfile-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  write(seed, 'package.json', manifest(['a', 'c']));
  write(seed, 'pnpm-lock.yaml', lockfile(['a@1.0.0', 'c@1.0.0']));
  write(seed, 'src/value.ts', 'export const value = "old";\n');
  if (options.markerSize?.base) write(seed, '.gitattributes', attributes(options.markerSize.base));
  if (options.bun) {
    write(seed, 'container/Dockerfile', 'ARG BUN_VERSION=1.4.4\n');
    write(seed, 'container/agent-runner/package.json', manifest(['a', 'c']));
    write(seed, 'container/agent-runner/bun.lock', lockfile(['a@1.0.0', 'c@1.0.0']));
  }
  commit(seed, 'base');
  const official = temp('lockfile-official-');
  git(seed, ['clone', '-q', '--bare', seed, official]);

  write(seed, 'pnpm-lock.yaml', lockfile(['a@1.0.0', 'c@1.0.1']));
  if (options.bun) write(seed, 'container/agent-runner/bun.lock', lockfile(['a@1.0.0', 'c@1.0.1']));
  write(seed, 'src/value.ts', 'export const value = "new";\n');
  if (options.markerSize?.upstream) write(seed, '.gitattributes', attributes(options.markerSize.upstream));
  commit(seed, 'upstream bump');
  git(seed, ['push', '-q', official, 'main']);

  const install = temp('lockfile-install-');
  git(install, ['clone', '-q', official, '.']);
  git(install, ['checkout', '-q', '-B', 'main', 'HEAD~1']);
  git(install, ['config', 'user.name', 'Test']);
  git(install, ['config', 'user.email', 'test@example.com']);
  git(install, ['config', 'commit.gpgsign', 'false']);
  write(install, 'package.json', manifest(['a', 'b', 'c']));
  write(install, 'pnpm-lock.yaml', lockfile(['a@1.0.0', 'b@1.0.0', 'c@1.0.0']));
  if (options.bun) {
    write(install, 'container/agent-runner/package.json', manifest(['a', 'b', 'c']));
    write(install, 'container/agent-runner/bun.lock', lockfile(['a@1.0.0', 'b@1.0.0', 'c@1.0.0']));
  }
  if (options.otherConflict) write(install, 'src/value.ts', 'export const value = "local";\n');
  commit(install, 'setup: apply add-example');
  git(install, ['fetch', '-q', 'origin']);
  return { install };
}

/** Stands in for the controller being killed while the package manager runs. */
class Interrupted extends Error {}

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

/**
 * Real git; pnpm and bun stand-ins that only add missing manifest entries to the
 * lockfile. This checks the controller's git handling; the real package
 * managers are exercised by the update e2e run.
 */
function runner(
  options: {
    failRegenerate?: boolean;
    hostBun?: string;
    interrupt?: boolean;
    interruptGit?: string;
    interruptWith?: (cwd: string, args: string[]) => void;
    markers?: boolean;
    stray?: 'untracked' | 'tracked' | 'index';
  } = {},
) {
  const calls: Call[] = [];
  const regenerate = (cwd: string): void => {
    const file = fs.existsSync(path.join(cwd, 'bun.lock')) ? 'bun.lock' : 'pnpm-lock.yaml';
    const deps = Object.keys(JSON.parse(read(cwd, 'package.json')).dependencies);
    let lock = read(cwd, file);
    for (const dep of deps) if (!lock.includes(`  ${dep}@`)) lock += `  ${dep}@1.0.0: {}\n`;
    write(cwd, file, options.markers ? `<<<<<<< HEAD\n${lock}=======\n>>>>>>> x\n` : lock);
    if (options.stray === 'untracked') write(cwd, 'stray.txt', 'unexpected\n');
    if (options.stray === 'tracked') write(cwd, 'src/value.ts', 'export const value = "rewritten";\n');
    if (options.stray === 'index') {
      write(cwd, 'staged.txt', 'unexpected\n');
      git(cwd, ['add', 'staged.txt']);
    }
  };
  const exec = (command: string, args: string[], cwd: string): string => {
    if (command === 'git' && args[0] === options.interruptGit) {
      // Killed partway: by default after git stops, before the controller saves anything.
      if (options.interruptWith) options.interruptWith(cwd, args);
      else {
        try {
          git(cwd, args);
        } catch {
          // git exits non-zero when it stops on a conflict.
        }
      }
      throw new Interrupted('killed');
    }
    if (command === 'git') return git(cwd, args);
    calls.push({ command, args, cwd });
    if (command === 'bun' && args[0] === '--version') {
      if (!options.hostBun) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return options.hostBun;
    }
    if (args.includes('--lockfile-only')) {
      if (options.failRegenerate)
        throw Object.assign(new Error('failed'), { stdout: 'ERR_PNPM_FETCH_404 network down' });
      regenerate(cwd);
      if (options.interrupt) throw new Interrupted('killed');
    }
    return '';
  };
  const commandRunner: CommandRunner = {
    run: (command, args, cwd = process.cwd()) => exec(command, args, cwd),
    tryRun(command, args, cwd = process.cwd()) {
      try {
        return { ok: true, stdout: exec(command, args, cwd) };
      } catch (err) {
        if (err instanceof Interrupted) throw err;
        const failed = err as { stdout?: Buffer | string; stderr?: Buffer | string };
        return {
          ok: false,
          stdout: [failed.stdout, failed.stderr]
            .map((p) => p?.toString() ?? '')
            .join('')
            .trim(),
        };
      }
    },
  };
  return { runtime: createUpdateRuntime(commandRunner), calls };
}

function prepare(install: string, runtime: ReturnType<typeof runner>['runtime'], strategy?: UpdateState['strategy']) {
  return prepareUpdate({ projectRoot: install, upstreamRef: 'origin/main', strategy }, runtime);
}

/** The id of the one transaction a killed prepare left behind. */
function onlyTransaction(): string {
  const root = process.env.NANOCLAW_UPDATE_DIR!;
  const ids = fs.readdirSync(root).filter((id) => fs.existsSync(path.join(root, id, 'state.json')));
  expect(ids).toHaveLength(1);
  return ids[0];
}

function unmerged(stage: string): string[] {
  return git(stage, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
}

beforeEach(() => {
  previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
  process.env.NANOCLAW_UPDATE_DIR = temp('lockfile-updates-');
});

afterEach(() => {
  if (previousUpdateDir === undefined) delete process.env.NANOCLAW_UPDATE_DIR;
  else process.env.NANOCLAW_UPDATE_DIR = previousUpdateDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('update lockfile conflicts', () => {
  it('regenerates a lockfile-only conflict from upstream and reaches prepared', () => {
    const { install } = fixture();
    const { runtime, calls } = runner();

    const state = prepare(install, runtime);

    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['pnpm-lock.yaml']);
    const lock = read(state.stageRoot, 'pnpm-lock.yaml');
    expect(lock).toContain('c@1.0.1'); // upstream's lockfile-only bump kept
    expect(lock).toContain('b@1.0.0'); // local dependency added back
    expect(lock).not.toMatch(/^[<=>]{7}/m);
    expect(read(state.stageRoot, 'src/value.ts')).toContain('"new"');
    expect(git(state.stageRoot, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    expect(git(state.stageRoot, ['status', '--porcelain'])).toBe('');
    expect(calls).toEqual([
      { command: 'pnpm', args: ['install', '--lockfile-only', '--ignore-scripts'], cwd: state.stageRoot },
    ]);
    // The live checkout is untouched.
    expect(read(install, 'pnpm-lock.yaml')).not.toContain('c@1.0.1');
  });

  it('regenerates the agent-runner bun.lock with the Bun the image pins', () => {
    const { install } = fixture({ bun: true });
    const { runtime, calls } = runner({ hostBun: '1.3.0' });

    const state = prepare(install, runtime);

    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['container/agent-runner/bun.lock', 'pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'container/agent-runner/bun.lock')).toMatch(
      /b@1\.0\.0[\s\S]*c@1\.0\.1|c@1\.0\.1[\s\S]*b@1\.0\.0/,
    );
    const bun = calls.find((call) => call.args.includes('dlx'));
    expect(bun).toEqual({
      command: 'pnpm',
      args: ['--package=bun@1.4.4', 'dlx', 'bun', 'install', '--lockfile-only', '--ignore-scripts'],
      cwd: path.join(state.stageRoot, 'container/agent-runner'),
    });

    const pinned = runner({ hostBun: '1.4.4' });
    const second = prepare(fixture({ bun: true }).install, pinned.runtime);
    expect(second.phase).toBe('prepared');
    expect(pinned.calls.some((call) => call.command === 'bun' && call.args[0] === 'install')).toBe(true);
  });

  it('still stops when another file conflicts too, and resume finishes the lockfiles', () => {
    const { install } = fixture({ otherConflict: true });
    const { runtime, calls } = runner();

    let state = prepare(install, runtime);

    expect(state.phase).toBe('conflict');
    expect(unmerged(state.stageRoot).sort()).toEqual(['pnpm-lock.yaml', 'src/value.ts']);
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toMatch(/^<{7}/m);
    expect(state.lastError).toContain('CONFLICT');
    expect(state.lastError).toContain('Do not edit pnpm-lock.yaml: resolve and git add the other files');
    expect(calls).toEqual([]);

    // Resume refuses while the other file is still unresolved.
    expect(() => resumePreparedUpdate(install, state.id, runtime)).toThrow(/must be clean/);
    expect(calls).toEqual([]);

    write(state.stageRoot, 'src/value.ts', 'export const value = "local and new";\n');
    git(state.stageRoot, ['add', 'src/value.ts']);
    state = resumePreparedUpdate(install, state.id, runtime);

    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'src/value.ts')).toContain('local and new');
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toContain('c@1.0.1');
  });

  it('falls back to the conflict as git left it when regenerating fails, and resume retries', () => {
    const { install } = fixture();
    const failing = runner({ failRegenerate: true });

    let state = prepare(install, failing.runtime);

    expect(state.phase).toBe('conflict');
    expect(state.regeneratedLockfiles).toBeUndefined();
    expect(state.lastError).toContain('Only lockfiles conflicted (pnpm-lock.yaml), but regenerating them failed');
    expect(state.lastError).toContain('ERR_PNPM_FETCH_404 network down');
    expect(state.lastError).toContain('Never merge a lockfile by hand');
    expect(unmerged(state.stageRoot)).toEqual(['pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toMatch(/^<{7}[\s\S]*^={7}[\s\S]*^>{7}/m);

    state = resumePreparedUpdate(install, state.id, runner().runtime);
    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['pnpm-lock.yaml']);
  });

  it.each([
    ['an untracked file', 'untracked', 'stray.txt'],
    ['a tracked file', 'tracked', 'src/value.ts'],
    ['the index', 'index', 'the git index'],
  ] as const)('falls back when the package manager also changes %s, and undoes it', (_, stray, named) => {
    const { install } = fixture();

    let state = prepare(install, runner({ stray }).runtime);

    expect(state.phase).toBe('conflict');
    expect(state.lastError).toContain(`it also changed ${named}`);
    expect(unmerged(state.stageRoot)).toEqual(['pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toMatch(/^<{7}/m);
    expect(read(state.stageRoot, 'src/value.ts')).toContain('"new"');
    for (const file of ['stray.txt', 'staged.txt']) expect(fs.existsSync(path.join(state.stageRoot, file))).toBe(false);

    // Nothing the failed attempt staged rides along on the retry.
    state = resumePreparedUpdate(install, state.id, runner().runtime);
    expect(state.phase).toBe('prepared');
    expect(git(state.stageRoot, ['ls-files', 'staged.txt', 'stray.txt'])).toBe('');
    expect(read(state.stageRoot, 'src/value.ts')).toContain('"new"');
  });

  it("does not run the package manager while the operator's own changes are in the stage, and says why", () => {
    const { install } = fixture({ otherConflict: true });
    const { runtime, calls } = runner();
    let state = prepare(install, runtime);
    write(state.stageRoot, 'src/value.ts', 'export const value = "resolved";\n');
    git(state.stageRoot, ['add', 'src/value.ts']);
    write(state.stageRoot, 'src/value.ts', 'export const value = "resolved again";\n');
    write(state.stageRoot, 'src/value.ts.orig', 'mergetool backup\n');

    state = resumePreparedUpdate(install, state.id, runtime);

    expect(state.phase).toBe('conflict');
    expect(state.lastError).toBe(
      'Did not regenerate pnpm-lock.yaml: the stage has changes that are not added ' +
        '(src/value.ts, src/value.ts.orig). git add or remove them, then resume.',
    );
    expect(loadState(install, state.id).lastError).toBe(state.lastError);
    expect(calls).toEqual([]);
    expect(unmerged(state.stageRoot)).toEqual(['pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'src/value.ts.orig')).toBe('mergetool backup\n');

    git(state.stageRoot, ['add', 'src/value.ts']);
    fs.rmSync(path.join(state.stageRoot, 'src/value.ts.orig'));
    state = resumePreparedUpdate(install, state.id, runtime);

    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toContain('b@1.0.0');
  });

  it('never commits a lockfile the package manager left with conflict markers', () => {
    const { install } = fixture();

    const state = prepare(install, runner({ markers: true }).runtime);

    expect(state.phase).toBe('conflict');
    expect(state.lastError).toContain('pnpm-lock.yaml still has conflict markers');
    expect(unmerged(state.stageRoot)).toEqual(['pnpm-lock.yaml']);
    expect(git(state.stageRoot, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).not.toBe('');
  });

  it('regenerates a lockfile that was staged with its conflict markers', () => {
    const { install } = fixture({ otherConflict: true });
    const { runtime } = runner();
    let state = prepare(install, runtime);
    write(state.stageRoot, 'src/value.ts', 'export const value = "local and new";\n');
    git(state.stageRoot, ['add', '-A']);
    expect(unmerged(state.stageRoot)).toEqual([]);
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toMatch(/^<{7}/m);

    state = resumePreparedUpdate(install, state.id, runtime);

    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['pnpm-lock.yaml']);
    const committed = git(state.stageRoot, ['show', 'HEAD:pnpm-lock.yaml']);
    expect(committed).not.toMatch(/^[<=>]{7}/m);
    expect(committed).toContain('c@1.0.1');
    expect(committed).toContain('b@1.0.0');
    expect(read(state.stageRoot, 'src/value.ts')).toContain('local and new');
    expect(git(state.stageRoot, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
  });

  it('puts a staged marked lockfile back to the conflict when regenerating fails', () => {
    const { install } = fixture();
    let state = prepare(install, runner({ failRegenerate: true }).runtime);
    git(state.stageRoot, ['add', '-A']);
    expect(unmerged(state.stageRoot)).toEqual([]);
    const head = git(state.stageRoot, ['rev-parse', 'HEAD']);

    state = resumePreparedUpdate(install, state.id, runner({ failRegenerate: true }).runtime);

    expect(state.phase).toBe('conflict');
    expect(state.lastError).toContain('regenerating them failed');
    expect(state.lastError).toContain('git checkout MERGE_HEAD -- <file>');
    expect(git(state.stageRoot, ['rev-parse', 'HEAD'])).toBe(head);
    // git's resolve-undo record lets `checkout -m` restore the unmerged entry, so it cannot be committed.
    expect(unmerged(state.stageRoot)).toEqual(['pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toMatch(/^<{7}/m);

    state = resumePreparedUpdate(install, state.id, runner().runtime);
    expect(state.phase).toBe('prepared');
    expect(git(state.stageRoot, ['show', 'HEAD:pnpm-lock.yaml'])).not.toMatch(/^[<=>]{7}/m);
  });

  it('refuses a lockfile committed with conflict markers', () => {
    const { install } = fixture({ otherConflict: true });
    const { runtime, calls } = runner();
    const state = prepare(install, runtime);
    write(state.stageRoot, 'src/value.ts', 'export const value = "local and new";\n');
    git(state.stageRoot, ['add', '-A']);
    git(state.stageRoot, ['commit', '-q', '--no-edit']);

    expect(() => resumePreparedUpdate(install, state.id, runtime)).toThrow(
      'pnpm-lock.yaml in the stage still has conflict markers. Never merge a lockfile by hand: ' +
        'take a clean copy (git checkout origin/main -- <file>)',
    );
    expect(loadState(install, state.id).phase).toBe('conflict');
    expect(calls).toEqual([]);
  });

  it.each([
    ['an unmerged lockfile', 'src/value.ts'],
    ['a lockfile staged with markers', '-A'],
  ] as const)('finds %s again after a regenerate is killed midway', (_, add) => {
    const { install } = fixture({ otherConflict: true });
    let state = prepare(install, runner().runtime);
    write(state.stageRoot, 'src/value.ts', 'export const value = "local and new";\n');
    git(state.stageRoot, ['add', add]);

    expect(() => resumePreparedUpdate(install, state.id, runner({ interrupt: true }).runtime)).toThrow('killed');
    state = resumePreparedUpdate(install, state.id, runner().runtime);

    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['pnpm-lock.yaml']);
    expect(git(state.stageRoot, ['show', 'HEAD:pnpm-lock.yaml'])).toContain('b@1.0.0');
  });

  it('resumes a prepare killed while it regenerates', () => {
    const { install } = fixture();

    expect(() => prepare(install, runner({ interrupt: true }).runtime)).toThrow('killed');
    const id = onlyTransaction();
    expect(loadState(install, id).phase).toBe('conflict');
    const state = resumePreparedUpdate(install, id, runner().runtime);

    expect(state.phase).toBe('prepared');
    expect(state.lastError).toBeUndefined();
    expect(state.regeneratedLockfiles).toEqual(['pnpm-lock.yaml']);
    expect(git(state.stageRoot, ['show', 'HEAD:pnpm-lock.yaml'])).toContain('b@1.0.0');
  });

  it.each(['rebase', 'cherry-pick'] as const)('resumes a prepare killed mid-%s only once it finishes', (strategy) => {
    const { install } = fixture();
    // Cherry-pick gets two commits, so a commit by hand after the first leaves the second pending.
    git(install, ['checkout', '-q', '-b', 'extra', 'origin/main']);
    write(install, 'src/extra.ts', 'export const extra = 1;\n');
    commit(install, 'upstream extra');
    git(install, ['checkout', '-q', 'main']);
    const commits = strategy === 'cherry-pick' ? [git(install, ['rev-parse', 'origin/main']), 'extra'] : undefined;
    const { runtime } = runner({ interruptGit: strategy });

    expect(() =>
      prepareUpdate({ projectRoot: install, upstreamRef: 'origin/main', strategy, commits }, runtime),
    ).toThrow('killed');
    const id = onlyTransaction();
    const { stageRoot } = loadState(install, id);
    expect(loadState(install, id).phase).toBe('conflict');
    write(stageRoot, 'pnpm-lock.yaml', lockfile(['a@1.0.0', 'b@1.0.0', 'c@1.0.1']));
    git(stageRoot, ['add', 'pnpm-lock.yaml']);
    git(stageRoot, ['commit', '-q', '-m', 'resolved']);

    expect(() => resumePreparedUpdate(install, id, runner().runtime)).toThrow(
      `The staging worktree has an unfinished ${strategy}: finish it (git ${strategy} --continue), then resume`,
    );
    git(stageRoot, ['-c', 'core.editor=true', strategy, '--continue']);
    const state = resumePreparedUpdate(install, id, runner().runtime);

    expect(state.phase).toBe('prepared');
    expect(state.changedFiles).toContain('pnpm-lock.yaml');
    if (strategy === 'cherry-pick') expect(state.changedFiles).toContain('src/extra.ts');
  });

  it.each(['merge', 'rebase', 'cherry-pick'] as const)(
    'asks for a new prepare when prepare was killed before the %s ran',
    (strategy) => {
      const { install } = fixture();
      const commits = strategy === 'cherry-pick' ? [git(install, ['rev-parse', 'origin/main'])] : undefined;
      const killed = runner({ interruptGit: strategy, interruptWith: () => {} }).runtime;

      expect(() =>
        prepareUpdate({ projectRoot: install, upstreamRef: 'origin/main', strategy, commits }, killed),
      ).toThrow('killed');
      const id = onlyTransaction();
      const state = resumePreparedUpdate(install, id, runner().runtime);

      expect(state.phase).toBe('conflict');
      expect(state.lastError).toBe(
        `The stage has none of the update: the ${strategy} never ran or was undone. ` +
          'Abandon this update and prepare again.',
      );
      expect(git(state.stageRoot, ['rev-parse', 'HEAD'])).toBe(state.originalHead);
    },
  );

  it('refuses a rebase killed after it moved HEAD but before it recorded any state', () => {
    const { install } = fixture();
    // The apply backend checks out upstream before it writes rebase-apply.
    const detach = (cwd: string) => git(cwd, ['checkout', '-q', '--detach', 'origin/main']);

    expect(() => prepare(install, runner({ interruptGit: 'rebase', interruptWith: detach }).runtime, 'rebase')).toThrow(
      'killed',
    );
    const id = onlyTransaction();

    expect(() => resumePreparedUpdate(install, id, runner().runtime)).toThrow(
      `The staging worktree must be on update-nanoclaw/${id}: finish any rebase (git rebase --continue) ` +
        'or put HEAD back on that branch, then resume',
    );
    expect(loadState(install, id).phase).toBe('conflict');
  });

  it('leaves a renamed stage branch alone instead of regenerating on it', () => {
    const { install } = fixture({ otherConflict: true });
    const { runtime, calls } = runner();
    const state = prepare(install, runtime);
    write(state.stageRoot, 'src/value.ts', 'export const value = "local and new";\n');
    git(state.stageRoot, ['add', 'src/value.ts']);
    git(state.stageRoot, ['branch', '-m', 'renamed']);
    const head = git(state.stageRoot, ['rev-parse', 'HEAD']);

    expect(() => resumePreparedUpdate(install, state.id, runtime)).toThrow(
      `The staging worktree must be on ${state.stageBranch}:`,
    );
    expect(calls).toEqual([]);
    expect(git(state.stageRoot, ['rev-parse', 'HEAD'])).toBe(head);
    expect(unmerged(state.stageRoot)).toEqual(['pnpm-lock.yaml']);
    expect(loadState(install, state.id).phase).toBe('conflict');
  });

  it('refuses a cherry-pick with no commits before it creates anything', () => {
    const { install } = fixture();

    expect(() => prepare(install, runner().runtime, 'cherry-pick')).toThrow(
      'Cherry-pick strategy requires at least one commit',
    );
    expect(fs.readdirSync(process.env.NANOCLAW_UPDATE_DIR!)).toEqual([]);
    expect(git(install, ['branch', '--list', 'backup/*'])).toBe('');
  });

  it.each([
    ['set before the merge', { base: 12 }],
    ['added by upstream', { upstream: 12 }],
    ['changed by upstream', { base: 3, upstream: 12 }],
  ] as const)('finds markers when conflict-marker-size is %s', (_, markerSize) => {
    const { install } = fixture({ otherConflict: true, markerSize });
    const { runtime } = runner();
    const state = prepare(install, runtime);
    // git sizes the markers by the attributes it had before the merge.
    const size = 'base' in markerSize ? markerSize.base : 7;
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toMatch(new RegExp(`^<{${size}} `, 'm'));
    write(state.stageRoot, 'src/value.ts', 'export const value = "local and new";\n');
    git(state.stageRoot, ['add', '-A']);
    git(state.stageRoot, ['commit', '-q', '--no-edit']);

    expect(() => resumePreparedUpdate(install, state.id, runtime)).toThrow(
      'pnpm-lock.yaml in the stage still has conflict markers',
    );
  });

  it('validate refuses a marked lockfile before installing', async () => {
    const { install } = fixture();
    const { runtime, calls } = runner();
    const state = prepare(install, runtime);
    expect(state.phase).toBe('prepared');
    write(
      state.stageRoot,
      'pnpm-lock.yaml',
      `<<<<<<< HEAD\n${read(state.stageRoot, 'pnpm-lock.yaml')}=======\n>>>>>>> x\n`,
    );
    git(state.stageRoot, ['commit', '-q', '-am', 'marked']);
    calls.length = 0;

    await expect(validateUpdate(install, state.id, runtime)).rejects.toThrow(
      /pnpm-lock\.yaml in the stage still has conflict markers/,
    );
    expect(calls).toEqual([]);
  });

  it('leaves a rebase conflict to the operator', () => {
    const { install } = fixture();
    const { runtime, calls } = runner();

    const state = prepare(install, runtime, 'rebase');

    expect(state.phase).toBe('conflict');
    expect(state.regeneratedLockfiles).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
