/**
 * The diff view, read through the session's exec: the argv git gets inside
 * the container (no external diff, no textconv, no fsmonitor), a real
 * temporary repository standing in for the session (tracked change and
 * untracked file both appear, nothing written to the repo, a repository
 * that names an external diff helper never runs it), the byte bounds and
 * their markers, the not-a-repo answer, the no-HEAD fallback, and the cold
 * session that yields no diff at all.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionExecSpec, SessionHandle } from '../../drivers/types.js';
import {
  boundDiff,
  collectDiff,
  collectSandboxDiff,
  DiffCollectError,
  DIFF_OUTPUT_CUT_MARKER,
  DIFF_TRUNCATED_TRAILER,
  gitReadArgv,
  parseStatus,
  type DiffExec,
} from './diff-view.js';

let dir: string;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, ...GIT_ENV, HOME: dir },
  }).toString();
}

/** A handle whose exec runs the command on this machine: the temp repo stands in for the session's tree. */
function localHandle(): SessionHandle {
  return {
    key: { installSlug: 'i', agentGroupId: 'ag-1', sessionId: 's-1' },
    name: 'ncl-s-1',
    start: async () => {},
    status: async () => ({ phase: 'running' }),
    stop: async () => {},
    execSpec: (command) => ({ bin: command[0], argsTty: command.slice(1), argsPlain: command.slice(1) }),
  };
}

/** A handle that only describes the exec, for the scripted `run` seam. */
function describedHandle(): SessionHandle {
  return {
    ...localHandle(),
    execSpec: (command) => ({
      bin: 'fake-runtime',
      argsTty: ['exec', '-it', 'ncl-s-1', ...command],
      argsPlain: ['exec', '-i', 'ncl-s-1', ...command],
    }),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-diff-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('collectDiff through a real repository', () => {
  it('shows tracked changes and untracked files as unified diffs, without touching the index', async () => {
    git('init', '-q', '-b', 'work');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 1;\n');
    git('add', 'app.ts');
    git('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 2;\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', "it's new.ts"), 'export const fresh = true;\n');

    const view = await collectDiff(localHandle(), { workspaceDir: dir });
    expect(view).not.toBeNull();
    expect(view!.truncated).toBe(false);
    expect(view!.headBranch).toBe('work');
    expect(view!.content).toContain('-const a = 1;');
    expect(view!.content).toContain('+const a = 2;');
    expect(view!.content).toContain('new file mode');
    expect(view!.content).toContain('+export const fresh = true;');
    // The view is a read: the new file stays untracked, the change stays unstaged.
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe(' M app.ts\n?? "src/it\'s new.ts"\n');
  });

  it("a repository's external diff driver and textconv are never run", async () => {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 1;\n');
    git('add', 'app.ts');
    git('commit', '-q', '-m', 'init');
    // The helper lives outside the tree so it is the config, not an untracked file, that names it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-diff-helper-'));
    const marker = path.join(outside, 'helper-ran');
    const helper = path.join(outside, 'helper.sh');
    fs.writeFileSync(helper, `#!/bin/sh\nprintf ran > '${marker}'\nprintf 'helper output\\n'\n`, { mode: 0o755 });
    git('config', 'diff.external', helper);
    git('config', 'diff.ts.textconv', helper);
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.ts diff=ts\n');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 2;\n');

    const view = await collectDiff(localHandle(), { workspaceDir: dir });
    expect(fs.existsSync(marker)).toBe(false);
    expect(view!.content).not.toContain('helper output');
    expect(view!.content).toContain('+const a = 2;');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('a clean tree yields empty content; a repository with no commit yet still works', async () => {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const view = await collectDiff(localHandle(), { workspaceDir: dir });
    expect(view).not.toBeNull();
    expect(view!.content).toContain('+hello');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    expect((await collectDiff(localHandle(), { workspaceDir: dir }))!.content).toBe('');
  });

  it('not a repository → null', async () => {
    expect(await collectDiff(localHandle(), { workspaceDir: dir })).toBeNull();
  });
});

describe('the exec argv', () => {
  function scripted(answers: (sub: string[]) => { stdout: string; code: number; truncated?: boolean }) {
    const specs: SessionExecSpec[] = [];
    const run: DiffExec = async (spec) => {
      specs.push(spec);
      // argsPlain = ['exec', '-i', 'ncl-s-1', 'git', '-C', ws, '-c', 'core.fsmonitor=', '--no-pager', ...sub]
      const command = spec.argsPlain.slice(3);
      return answers(command[0] === 'git' ? command.slice(6) : command);
    };
    return { specs, run };
  }

  it('every git read runs in the session as the plain exec, with the helpers switched off', async () => {
    const { specs, run } = scripted((sub) => {
      if (sub[0] === 'status') return { stdout: '# branch.head main\0? new.txt\0', code: 0 };
      if (sub[0] === 'diff' && sub.includes('HEAD')) return { stdout: 'diff --git a/x b/x\n', code: 0 };
      if (sub[0] === 'sh') return { stdout: 'diff --git a/new.txt b/new.txt\n', code: 0 };
      return { stdout: '', code: 1 };
    });
    const view = await collectDiff(describedHandle(), { run });
    expect(view).toEqual({
      content: 'diff --git a/x b/x\ndiff --git a/new.txt b/new.txt\n',
      truncated: false,
      headBranch: 'main',
    });
    expect(
      specs.every((s) => s.bin === 'fake-runtime' && s.argsPlain.slice(0, 3).join(' ') === 'exec -i ncl-s-1'),
    ).toBe(true);
    const commands = specs.map((s) => s.argsPlain.slice(3));
    expect(commands[0]).toEqual(
      gitReadArgv('/workspace/group', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'),
    );
    expect(commands[0].slice(0, 6)).toEqual(['git', '-C', '/workspace/group', '-c', 'core.fsmonitor=', '--no-pager']);
    expect(commands[1]).toEqual(
      gitReadArgv('/workspace/group', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', 'HEAD', '--'),
    );
    // The untracked loop: one sh, the paths as positional arguments, the same flags inside.
    expect(commands[2].slice(0, 2)).toEqual(['sh', '-c']);
    expect(commands[2][2]).toContain("'--no-ext-diff' '--no-textconv' '--no-index' '--' '/dev/null' \"$f\"");
    expect(commands[2].slice(3)).toEqual(['sh', 'new.txt']);
  });

  it('not a repository (status exits 128) → null and nothing else is run; any other failure throws', async () => {
    const { specs, run } = scripted(() => ({ stdout: 'fatal: not a git repository', code: 128 }));
    expect(await collectDiff(describedHandle(), { run })).toBeNull();
    expect(specs).toHaveLength(1);
    const broken = scripted(() => ({ stdout: '', code: 1 }));
    await expect(collectDiff(describedHandle(), { run: broken.run })).rejects.toBeInstanceOf(DiffCollectError);
    const diffBroken = scripted((sub) =>
      sub[0] === 'status' ? { stdout: '# branch.head main\0', code: 0 } : { stdout: '', code: 129 },
    );
    await expect(collectDiff(describedHandle(), { run: diffBroken.run })).rejects.toThrow('git diff exited 129');
  });

  it('falls back to the plain diff when HEAD does not exist, and a detached head names no branch', async () => {
    const { run } = scripted((sub) => {
      if (sub[0] === 'status') return { stdout: '# branch.oid (initial)\0# branch.head (detached)\0', code: 0 };
      if (sub[0] === 'diff' && sub.includes('HEAD')) return { stdout: '', code: 128 };
      if (sub[0] === 'diff') return { stdout: 'diff --git a/x b/x\n', code: 0 };
      return { stdout: '', code: 1 };
    });
    expect(await collectDiff(describedHandle(), { run })).toEqual({
      content: 'diff --git a/x b/x\n',
      truncated: false,
    });
  });

  it('honours maxBytes and the untracked-file cap', async () => {
    const { specs, run } = scripted((sub) => {
      if (sub[0] === 'status') return { stdout: '# branch.head main\0? a\0? b\0? c\0? d\0', code: 0 };
      if (sub[0] === 'diff') return { stdout: '', code: 0 };
      if (sub[0] === 'sh') {
        const files = sub.slice(3);
        return { stdout: files.map((f) => `diff --git a/${f} b/${f}\n${'+'.repeat(300)}\n`).join(''), code: 0 };
      }
      return { stdout: '', code: 1 };
    });
    const view = await collectDiff(describedHandle(), { run, maxBytes: 500, maxUntrackedFiles: 2 });
    expect(view!.truncated).toBe(true);
    expect(Buffer.byteLength(view!.content, 'utf8')).toBeLessThanOrEqual(500);
    expect(view!.content.endsWith(DIFF_TRUNCATED_TRAILER)).toBe(true);
    // Only the first two untracked files were even asked for.
    expect(specs.at(-1)!.argsPlain.slice(-2)).toEqual(['a', 'b']);
  });

  it('an exec that hit its byte cap is marked cut, and the untracked read is skipped', async () => {
    const { specs, run } = scripted((sub) => {
      if (sub[0] === 'status') return { stdout: '# branch.head main\0? new.txt\0', code: 0 };
      if (sub[0] === 'diff') return { stdout: 'diff --git a/x b/x\n+huge', code: 0, truncated: true };
      return { stdout: '', code: 1 };
    });
    const view = await collectDiff(describedHandle(), { run });
    expect(view!.truncated).toBe(true);
    expect(view!.content).toBe('diff --git a/x b/x\n+huge' + DIFF_OUTPUT_CUT_MARKER);
    expect(specs).toHaveLength(2);
  });
});

describe('collectSandboxDiff', () => {
  it('a cold session yields no diff: the host does not read the tree itself', async () => {
    const run: DiffExec = async () => {
      throw new Error('must not run');
    };
    expect(await collectSandboxDiff('ag-1', { findLiveHandle: async () => undefined, run })).toEqual({ live: false });
  });

  it('a live session is read through its handle', async () => {
    const run: DiffExec = async (spec) =>
      spec.argsPlain.includes('status') ? { stdout: '# branch.head main\0', code: 0 } : { stdout: '', code: 0 };
    expect(await collectSandboxDiff('ag-1', { findLiveHandle: async () => describedHandle(), run })).toEqual({
      live: true,
      ok: true,
      view: { content: '', truncated: false, headBranch: 'main' },
    });
  });

  it('a read that failed is reported as such, never as a clean tree', async () => {
    const threw: DiffExec = async () => {
      throw new Error('exec failed');
    };
    const failed = await collectSandboxDiff('ag-1', { findLiveHandle: async () => describedHandle(), run: threw });
    expect(failed).toMatchObject({ live: true, ok: false });
    expect((failed as { error: unknown }).error).toBeInstanceOf(DiffCollectError);
    const exited: DiffExec = async () => ({ stdout: '', code: 1 });
    expect(
      await collectSandboxDiff('ag-1', { findLiveHandle: async () => describedHandle(), run: exited }),
    ).toMatchObject({ live: true, ok: false });
  });
});

describe('parseStatus', () => {
  it('reads the head, the untracked paths, and steps over a rename entry', () => {
    const out = [
      '# branch.oid abc',
      '# branch.head feature/x',
      '1 .M N... 100644 100644 100644 abc abc app.ts',
      '2 R. N... 100644 100644 100644 abc abc R100 new-name.ts',
      'old-name.ts',
      '? untracked one.txt',
      '? dir/two.txt',
      '',
    ].join('\0');
    expect(parseStatus(out)).toEqual({ untracked: ['untracked one.txt', 'dir/two.txt'], headBranch: 'feature/x' });
    expect(parseStatus('# branch.head (detached)\0')).toEqual({ untracked: [] });
  });
});

describe('bounds', () => {
  it('cuts on a line boundary and appends the trailer', () => {
    const line = 'x'.repeat(50) + '\n';
    const content = line.repeat(100);
    const bounded = boundDiff(content, 1_000);
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.content, 'utf8')).toBeLessThanOrEqual(1_000);
    expect(bounded.content.endsWith(DIFF_TRUNCATED_TRAILER)).toBe(true);
    const body = bounded.content.slice(0, -DIFF_TRUNCATED_TRAILER.length);
    expect(body.endsWith('\n')).toBe(true);
    expect(body.split('\n').every((l) => l === '' || l.length === 50)).toBe(true);
  });

  it('leaves small content alone', () => {
    expect(boundDiff('abc\n', 100)).toEqual({ content: 'abc\n', truncated: false });
  });
});
