import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareUpdate } from '../../scripts/update/transaction.js';
import {
  enforceUpgradeTripwire,
  isUpgradeCurrent,
  readUpgradeState,
  writeUpgradeState,
} from '../../src/upgrade-state.js';
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
  writeFileSync(join(root, '.gitignore'), '.env\ndata/\n');
  writeFileSync(join(root, 'package.json'), '{ "version": "1.0.0" }\n');
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

describe('setup commits keep the upgrade marker on HEAD', () => {
  // The service step stamped this checkout; a channel skill then commits.
  it('carries a marker that matched forward to the setup commit', async () => {
    const root = install();
    const stamped = writeUpgradeState({ via: 'setup', channel: 'stable', ref: 'refs/tags/v1', projectRoot: root });
    expect(stamped.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    const onError = vi.fn();

    await withSetupCommit(
      root,
      'telegram',
      async () => writeFileSync(join(root, 'src', 'telegram.ts'), '1\n'),
      onError,
    );

    expect(onError).not.toHaveBeenCalled();
    expect(git(root, 'log', '-1', '--format=%s')).toBe('setup: apply telegram');
    const marker = readUpgradeState(root)!;
    expect(marker.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(marker.tree).toBe(git(root, 'rev-parse', 'HEAD^{tree}'));
    expect(marker).toMatchObject({ via: 'setup', channel: 'stable', ref: 'refs/tags/v1' });
    expect(isUpgradeCurrent(root)).toBe(true);
  });

  it('leaves a marker that already mismatched alone (a raw git pull stays tripped)', async () => {
    const root = install();
    const stamped = writeUpgradeState({ via: 'setup', projectRoot: root });
    writeFileSync(join(root, 'README.md'), 'pulled\n');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'upstream pull');
    expect(isUpgradeCurrent(root)).toBe(false);

    await withSetupCommit(
      root,
      'telegram',
      async () => writeFileSync(join(root, 'src', 'telegram.ts'), '1\n'),
      vi.fn(),
    );

    expect(git(root, 'log', '-1', '--format=%s')).toBe('setup: apply telegram');
    expect(readUpgradeState(root)).toEqual(stamped);
    expect(isUpgradeCurrent(root)).toBe(false);
  });

  // HEAD still is the marked commit, but the code is not: an update left a
  // new package.json in the tree. The marker is stale and must stay so.
  it('leaves a marker that no longer matches the code alone even when HEAD did not move', async () => {
    const root = install();
    const stamped = writeUpgradeState({ via: 'setup', projectRoot: root });
    writeFileSync(join(root, 'package.json'), '{ "version": "2.0.0" }\n');
    expect(isUpgradeCurrent(root)).toBe(false);

    await withSetupCommit(
      root,
      'telegram',
      async () => writeFileSync(join(root, 'src', 'telegram.ts'), '1\n'),
      vi.fn(),
    );

    expect(git(root, 'log', '-1', '--format=%s')).toBe('setup: apply telegram');
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/telegram.ts');
    expect(readUpgradeState(root)).toEqual(stamped);
  });

  it('saves the fallback Git identity before it stamps', async () => {
    const root = install();
    writeUpgradeState({ via: 'setup', projectRoot: root });

    await withSetupCommit(
      root,
      'telegram',
      async () => writeFileSync(join(root, 'src', 'telegram.ts'), '1\n'),
      vi.fn(),
    );

    expect(git(root, 'config', '--local', 'user.email')).toBe('setup@nanoclaw.invalid');
    expect(isUpgradeCurrent(root)).toBe(true);
  });

  it('does not carry forward a marker recorded without Git', async () => {
    const root = install();
    writeUpgradeState({ via: 'setup', projectRoot: root });
    const marker = readUpgradeState(root)!;
    writeFileSync(
      join(root, 'data', 'upgrade-state.json'),
      JSON.stringify({ ...marker, commit: 'unknown', tree: 'unknown' }),
    );

    await withSetupCommit(
      root,
      'telegram',
      async () => writeFileSync(join(root, 'src', 'telegram.ts'), '1\n'),
      vi.fn(),
    );

    expect(git(root, 'log', '-1', '--format=%s')).toBe('setup: apply telegram');
    expect(readUpgradeState(root)!.commit).toBe('unknown');
  });

  it('does not stamp a checkout that never had a marker', async () => {
    const root = install();
    await withSetupCommit(
      root,
      'telegram',
      async () => writeFileSync(join(root, 'src', 'telegram.ts'), '1\n'),
      vi.fn(),
    );
    expect(readUpgradeState(root)).toBeNull();
  });

  // Setup's order: service step (stamp + first start), then the channel
  // skill apply (commit). The next start must pass the tripwire.
  it('a channel skill applied after the service step still boots', async () => {
    const root = install();
    const skill = payloadSkill();
    writeUpgradeState({ via: 'setup', projectRoot: root });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const exec = (cmd: string) => execFileSync('/bin/sh', ['-c', cmd], { cwd: root, encoding: 'utf8' });
      await runSkill(skill, { projectRoot: root, exec, onEvent: () => {} });
      expect(git(root, 'log', '-1', '--format=%s')).toMatch(/^setup: apply setup-commit-skill-/);
      expect(git(root, 'status', '--porcelain')).toBe('');

      expect(() => enforceUpgradeTripwire(root)).not.toThrow();
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
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
