import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUpdateRuntime, prepareUpdate, resumePreparedUpdate, type UpdateState } from './transaction.js';
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
  `${JSON.stringify({ name: 'x', dependencies: Object.fromEntries(deps.map((d) => [d, '1.0.0'])) })}\n`;
const lockfile = (entries: string[]) =>
  `lockfileVersion: '9.0'\n\npackages:\n${entries.map((e) => `  ${e}: {}\n`).join('')}`;

/**
 * Upstream bumps `c` in the lockfile only (a security fix); the install's
 * setup commit adds `b` to the manifest and lockfile next to it. Git cannot
 * merge the two, though the manifests merge cleanly: the conflict this fixes.
 */
function fixture(options: { bun?: boolean; otherConflict?: boolean } = {}): { install: string } {
  const seed = temp('lockfile-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  write(seed, 'package.json', manifest(['a', 'c']));
  write(seed, 'pnpm-lock.yaml', lockfile(['a@1.0.0', 'c@1.0.0']));
  write(seed, 'src/value.ts', 'export const value = "old";\n');
  if (options.bun) {
    write(seed, 'container/Dockerfile', 'ARG BUN_VERSION=1.4.4\n');
    write(seed, 'container/agent-runner/package.json', manifest(['a', 'c']));
    write(seed, 'container/agent-runner/bun.lock', lockfile(['a@1.0.0', 'c@1.0.0']));
  }
  commit(seed, 'base');
  const official = temp('lockfile-official-');
  git(seed, ['clone', '-q', '--bare', seed, official]);

  write(seed, 'pnpm-lock.yaml', lockfile(['a@1.0.0', 'c@2.0.0']));
  if (options.bun) write(seed, 'container/agent-runner/bun.lock', lockfile(['a@1.0.0', 'c@2.0.0']));
  write(seed, 'src/value.ts', 'export const value = "new";\n');
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

interface Call {
  command: string;
  args: string[];
  cwd: string;
}

/** Real git; pnpm and bun stand-ins that add missing manifest entries to the lockfile. */
function runner(options: { failRegenerate?: boolean; hostBun?: string; stray?: boolean } = {}) {
  const calls: Call[] = [];
  const regenerate = (cwd: string): void => {
    const file = fs.existsSync(path.join(cwd, 'bun.lock')) ? 'bun.lock' : 'pnpm-lock.yaml';
    const deps = Object.keys(JSON.parse(read(cwd, 'package.json')).dependencies);
    let lock = read(cwd, file);
    for (const dep of deps) if (!lock.includes(`  ${dep}@`)) lock += `  ${dep}@1.0.0: {}\n`;
    write(cwd, file, lock);
    if (options.stray) write(cwd, 'stray.txt', 'unexpected\n');
  };
  const exec = (command: string, args: string[], cwd: string): string => {
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
    }
    return '';
  };
  const commandRunner: CommandRunner = {
    run: (command, args, cwd = process.cwd()) => exec(command, args, cwd),
    tryRun(command, args, cwd = process.cwd()) {
      try {
        return { ok: true, stdout: exec(command, args, cwd) };
      } catch (err) {
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
    expect(lock).toContain('c@2.0.0'); // upstream's lockfile-only bump kept
    expect(lock).toContain('b@1.0.0'); // local dependency added back
    expect(lock).not.toMatch(/^[<=>]{7}/m);
    expect(read(state.stageRoot, 'src/value.ts')).toContain('"new"');
    expect(git(state.stageRoot, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    expect(git(state.stageRoot, ['status', '--porcelain'])).toBe('');
    expect(calls).toEqual([
      { command: 'pnpm', args: ['install', '--lockfile-only', '--ignore-scripts'], cwd: state.stageRoot },
    ]);
    // The live checkout is untouched.
    expect(read(install, 'pnpm-lock.yaml')).not.toContain('c@2.0.0');
  });

  it('regenerates the agent-runner bun.lock with the Bun the image pins', () => {
    const { install } = fixture({ bun: true });
    const { runtime, calls } = runner({ hostBun: '1.3.0' });

    const state = prepare(install, runtime);

    expect(state.phase).toBe('prepared');
    expect(state.regeneratedLockfiles).toEqual(['container/agent-runner/bun.lock', 'pnpm-lock.yaml']);
    expect(read(state.stageRoot, 'container/agent-runner/bun.lock')).toMatch(
      /b@1\.0\.0[\s\S]*c@2\.0\.0|c@2\.0\.0[\s\S]*b@1\.0\.0/,
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
    expect(state.lastError).toContain('Leave pnpm-lock.yaml as they are');
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
    expect(read(state.stageRoot, 'pnpm-lock.yaml')).toContain('c@2.0.0');
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

  it('falls back when the package manager changes anything besides the lockfile', () => {
    const { install } = fixture();

    const state = prepare(install, runner({ stray: true }).runtime);

    expect(state.phase).toBe('conflict');
    expect(state.lastError).toContain('it also changed stray.txt');
    expect(unmerged(state.stageRoot)).toEqual(['pnpm-lock.yaml']);
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
