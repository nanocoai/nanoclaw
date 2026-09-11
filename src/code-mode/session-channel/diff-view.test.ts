/**
 * The diff view: a real temporary repository (tracked change + untracked
 * file both appear, nothing written to the repo), the byte bound with its
 * trailer, the not-a-repo answer, and the scripted fallbacks (no HEAD yet,
 * git missing) through the run seam.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boundDiff, collectDiff, DIFF_TRUNCATED_TRAILER } from './diff-view.js';

let dir: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      HOME: dir,
    },
  }).toString();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-diff-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('collectDiff on a real repository', () => {
  it('shows tracked changes and untracked files as unified diffs, without touching the index', async () => {
    git('init', '-q', '-b', 'work');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 1;\n');
    git('add', 'app.ts');
    git('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 2;\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const fresh = true;\n');

    const view = await collectDiff(dir);
    expect(view).not.toBeNull();
    expect(view!.truncated).toBe(false);
    expect(view!.headBranch).toBe('work');
    expect(view!.content).toContain('-const a = 1;');
    expect(view!.content).toContain('+const a = 2;');
    expect(view!.content).toContain('new file mode');
    expect(view!.content).toContain('+export const fresh = true;');
    // The view is a read: the new file stays untracked, the change stays unstaged.
    expect(git('status', '--porcelain')).toBe(' M app.ts\n?? src/\n');
  });

  it('a clean tree yields empty content; a repository with no commit yet still works', async () => {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const view = await collectDiff(dir);
    expect(view).not.toBeNull();
    expect(view!.content).toContain('+hello');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    expect((await collectDiff(dir))!.content).toBe('');
  });

  it('not a repository → null', async () => {
    expect(await collectDiff(dir)).toBeNull();
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

  it('collectDiff honours maxBytes and the untracked-file cap through the run seam', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const sub = args.slice(4); // after -c safe.directory=* -C <dir>
      if (sub[0] === 'rev-parse' && sub[1] === '--is-inside-work-tree') return { stdout: 'true\n', code: 0 };
      if (sub[0] === 'diff' && sub[2] === 'HEAD') return { stdout: '', code: 0 };
      if (sub[0] === 'ls-files') return { stdout: ['a', 'b', 'c', 'd'].join('\0') + '\0', code: 0 };
      if (sub[0] === 'diff' && sub[2] === '--no-index') {
        return { stdout: `diff --git a/${sub[5]} b/${sub[5]}\n${'+'.repeat(300)}\n`, code: 1 };
      }
      if (sub[0] === 'rev-parse') return { stdout: 'main\n', code: 0 };
      return { stdout: '', code: 1 };
    };
    const view = await collectDiff('/repo', { run, maxBytes: 500, maxUntrackedFiles: 2 });
    expect(view!.truncated).toBe(true);
    expect(Buffer.byteLength(view!.content, 'utf8')).toBeLessThanOrEqual(500);
    // Only the first two untracked files were even asked for.
    const noIndex = calls.filter((c) => c.includes('--no-index'));
    expect(noIndex.map((c) => c.at(-1))).toEqual(['a', 'b']);
    expect(calls[0]).toEqual(['-c', 'safe.directory=*', '-C', '/repo', 'rev-parse', '--is-inside-work-tree']);
  });

  it('falls back to the plain diff when HEAD does not exist', async () => {
    const run = async (args: string[]) => {
      const sub = args.slice(4);
      if (sub[0] === 'rev-parse' && sub[1] === '--is-inside-work-tree') return { stdout: 'true\n', code: 0 };
      if (sub[0] === 'diff' && sub[2] === 'HEAD') return { stdout: '', code: 128 };
      if (sub[0] === 'diff' && sub[2] === '--') return { stdout: 'diff --git a/x b/x\n', code: 0 };
      if (sub[0] === 'ls-files') return { stdout: '', code: 0 };
      if (sub[0] === 'rev-parse') return { stdout: 'HEAD\n', code: 128 };
      return { stdout: '', code: 1 };
    };
    const view = await collectDiff('/repo', { run });
    expect(view).toEqual({ content: 'diff --git a/x b/x\n', truncated: false });
  });
});
