import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { gitShowToFileCommand } from './git-show-to-file.js';

const roots: string[] = [];

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'nanoclaw-git-show-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('gitShowToFileCommand', () => {
  it('preserves the destination on failure and replaces it only after a successful git show', () => {
    const root = makeRepo();
    const source = "source/source's file.ts";
    const destination = "output/destination's file.ts";
    mkdirSync(dirname(join(root, source)), { recursive: true });
    mkdirSync(dirname(join(root, destination)), { recursive: true });
    writeFileSync(join(root, source), 'from git\n');
    writeFileSync(join(root, destination), 'existing\n');
    execFileSync('git', ['add', source], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });

    const failed = spawnSync('sh', ['-c', gitShowToFileCommand('HEAD', 'missing.ts', destination)], {
      cwd: root,
    });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(join(root, destination), 'utf8')).toBe('existing\n');
    expect(readdirSync(dirname(join(root, destination))).filter((name) => name.startsWith('.git-show.'))).toEqual([]);

    execFileSync('sh', ['-c', gitShowToFileCommand('HEAD', source, destination)], { cwd: root });
    expect(readFileSync(join(root, destination), 'utf8')).toBe('from git\n');
    expect(readdirSync(dirname(join(root, destination))).filter((name) => name.startsWith('.git-show.'))).toEqual([]);
  });
});
