import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareUpdate } from '../../scripts/update/transaction.js';
import { commitSetupChanges, snapshotTree, withSetupCommit } from './setup-commit.js';
import { runSkill } from './skill-driver.js';

const temps: string[] = [];
let previousUpdateDir: string | undefined;
let previousGitEnv: Record<string, string | undefined> = {};

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

// A committed checkout with no Git identity configured, as on a fresh machine.
function install(): string {
  const root = temp('setup-commit-install-');
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'src', 'providers'), { recursive: true });
  writeFileSync(join(root, 'src', 'providers', 'index.ts'), '// barrel\n');
  writeFileSync(join(root, 'README.md'), 'readme\n');
  writeFileSync(join(root, '.gitignore'), '.env\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return root;
}

// A skill that materializes payload files and extends a tracked barrel, the
// shape of every provider, channel and gateway skill setup applies.
function payloadSkill(): string {
  const skill = temp('setup-commit-skill-');
  mkdirSync(join(skill, 'payload'));
  writeFileSync(join(skill, 'payload', 'example.ts'), 'export const example = 1;\n');
  writeFileSync(join(skill, 'payload', 'notes.md'), 'notes\n');
  writeFileSync(
    join(skill, 'SKILL.md'),
    [
      '# example',
      '',
      '```nc:copy',
      'payload/example.ts -> src/providers/example.ts',
      'payload/notes.md -> container/skills/example/notes.md',
      '```',
      '',
      '```nc:run effect:wire',
      'echo "import \'./example.js\';" >> src/providers/index.ts && echo SECRET=1 >> .env',
      '```',
      '',
    ].join('\n'),
  );
  return skill;
}

beforeEach(() => {
  // No global or system Git identity, as on a fresh machine.
  previousGitEnv = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
    NANOCLAW_SETUP_COMMIT: process.env.NANOCLAW_SETUP_COMMIT,
  };
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  delete process.env.NANOCLAW_SETUP_COMMIT;
  previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
  process.env.NANOCLAW_UPDATE_DIR = temp('setup-commit-updates-');
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousGitEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previousUpdateDir === undefined) delete process.env.NANOCLAW_UPDATE_DIR;
  else process.env.NANOCLAW_UPDATE_DIR = previousUpdateDir;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('setup skill applies leave an updatable checkout', () => {
  it('commits what the apply wrote so the updater accepts the fresh install', async () => {
    const root = install();
    const skill = payloadSkill();

    const exec = (cmd: string) => execFileSync('/bin/sh', ['-c', cmd], { cwd: root, encoding: 'utf8' });
    await runSkill(skill, { projectRoot: root, exec, onEvent: () => {} });

    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'log', '-1', '--format=%s')).toMatch(/^setup: apply setup-commit-skill-/);
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([
      'container/skills/example/notes.md',
      'src/providers/example.ts',
      'src/providers/index.ts',
    ]);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('SECRET=1\n');

    // Upstream moves on; merging it into the setup commit needs a committer.
    git(root, 'branch', 'upstream', 'HEAD~1');
    git(root, 'worktree', 'add', '-q', join(temp('setup-commit-upstream-'), 'wt'), 'upstream');
    const upstreamTree = git(root, 'worktree', 'list', '--porcelain').match(
      /worktree (.*setup-commit-upstream-.*)/,
    )![1];
    writeFileSync(join(upstreamTree, 'CHANGELOG.md'), 'new release\n');
    git(upstreamTree, 'add', '-A');
    git(upstreamTree, '-c', 'user.name=u', '-c', 'user.email=u@u', 'commit', '-qm', 'upstream release');
    expect(git(root, 'config', '--local', 'user.email')).toBe('setup@nanoclaw.invalid');
    expect(prepareUpdate({ projectRoot: root, upstreamRef: 'upstream' }).phase).toBe('prepared');
  });

  it('survives entries a content hash cannot read and notices mode-only changes', async () => {
    const root = install();
    mkdirSync(join(root, 'linked-dir'));
    writeFileSync(join(root, 'linked-dir', 'f'), 'f\n');
    symlinkSync(join(root, 'linked-dir'), join(root, 'dir-link'));
    writeFileSync(join(root, 'tool.sh'), 'echo\n');
    const onError = vi.fn();

    await withSetupCommit(root, 'example', async () => chmodSync(join(root, 'tool.sh'), 0o755), onError);

    expect(onError).not.toHaveBeenCalled();
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('tool.sh');
    expect(git(root, 'ls-files', '-s', 'tool.sh')).toMatch(/^100755/);
  });

  it("leaves the operator's own uncommitted edits alone", async () => {
    const root = install();
    writeFileSync(join(root, 'README.md'), 'my local edit\n');
    writeFileSync(join(root, 'scratch.txt'), 'mine\n');

    await withSetupCommit(
      root,
      'example',
      async () => {
        writeFileSync(join(root, 'src', 'providers', 'example.ts'), 'x\n');
      },
      () => {},
    );

    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/providers/example.ts');
    expect(git(root, 'diff', '--name-only')).toBe('README.md');
    expect(git(root, 'ls-files', '--others', '--exclude-standard')).toBe('scratch.txt');
  });

  it('commits a file the apply changed again even when it was already dirty', async () => {
    const root = install();
    writeFileSync(join(root, 'src', 'providers', 'index.ts'), '// barrel\nstale\n');
    const before = snapshotTree(root);
    writeFileSync(join(root, 'src', 'providers', 'index.ts'), '// barrel\nfresh\n');

    expect(commitSetupChanges(root, before, 'setup: apply example').committed).toEqual(['src/providers/index.ts']);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('commits a partial apply that throws, so a re-run starts clean', async () => {
    const root = install();
    await expect(
      withSetupCommit(
        root,
        'example',
        async () => {
          writeFileSync(join(root, 'src', 'providers', 'example.ts'), 'x\n');
          throw new Error('boom');
        },
        () => {},
      ),
    ).rejects.toThrow('boom');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('commits deletions and files whose names look like pathspec magic', async () => {
    const root = install();
    await withSetupCommit(
      root,
      'example',
      async () => {
        rmSync(join(root, 'README.md'));
        writeFileSync(join(root, 'src', 'providers', '[id]*.ts'), 'x\n');
      },
      () => {},
    );
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(git(root, 'ls-files', 'README.md')).toBe('');
  });

  it('skips the commit when NANOCLAW_SETUP_COMMIT=0, and only then', async () => {
    const write = (root: string) => async () => writeFileSync(join(root, 'src', 'providers', 'example.ts'), 'x\n');

    process.env.NANOCLAW_SETUP_COMMIT = '0';
    const optedOut = install();
    const head = git(optedOut, 'rev-parse', 'HEAD');
    await withSetupCommit(optedOut, 'example', write(optedOut), () => {});
    expect(git(optedOut, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(optedOut, 'status', '--porcelain')).toBe('?? src/providers/example.ts');

    process.env.NANOCLAW_SETUP_COMMIT = '1';
    const kept = install();
    await withSetupCommit(kept, 'example', write(kept), () => {});
    expect(git(kept, 'status', '--porcelain')).toBe('');
  });

  it('does nothing outside the top of a Git checkout', async () => {
    const plain = temp('setup-commit-plain-');
    expect(snapshotTree(plain)).toBeNull();

    const root = install();
    const nested = join(root, 'src');
    expect(snapshotTree(nested)).toBeNull();
    const head = git(root, 'rev-parse', 'HEAD');
    await withSetupCommit(
      nested,
      'example',
      async () => writeFileSync(join(nested, 'x.ts'), 'x\n'),
      () => {},
    );
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('reports a commit that landed when only saving the identity fails', async () => {
    const root = install();
    const before = snapshotTree(root);
    writeFileSync(join(root, 'src', 'providers', 'example.ts'), 'x\n');
    writeFileSync(join(root, '.git', 'config.lock'), '');

    const result = commitSetupChanges(root, before, 'setup: apply example');

    expect(result.committed).toEqual(['src/providers/example.ts']);
    expect(result.error).toMatch(/^Committed setup's files, but couldn't save a Git identity/);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('reports a commit failure instead of failing the apply', async () => {
    const root = install();
    writeFileSync(join(root, '.git', 'index.lock'), '');
    const onError = vi.fn();
    const result = await withSetupCommit(
      root,
      'example',
      async () => {
        writeFileSync(join(root, 'src', 'providers', 'example.ts'), 'x\n');
        return 'applied';
      },
      onError,
    );
    expect(result).toBe('applied');
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('index.lock'));
    // No commit was made, so no fallback identity is left on the checkout.
    expect(() => git(root, 'config', '--local', 'user.email')).toThrow();
  });
});
