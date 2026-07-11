import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

const guardScript = path.resolve('scripts/check-deploy-state.sh');
const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-deploy-guard-'));
  tempDirs.push(root);
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'repo');

  git(root, 'init', '--bare', remote);
  git(root, 'clone', remote, repo);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'main\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'branch', '-M', 'main');
  git(repo, 'push', '-u', 'origin', 'main');
  return repo;
}

function runGuard(repo: string): string {
  return execFileSync('/bin/bash', [guardScript, repo], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('部署状态检查', () => {
  it('HEAD 等于 origin/main 且工作树干净时通过', () => {
    const repo = makeRepo();

    expect(runGuard(repo)).toContain('部署状态检查通过');
  });

  it('当前分支提交落后于 origin/main 时拒绝部署', () => {
    const repo = makeRepo();
    git(repo, 'checkout', '-b', 'old-release');
    git(repo, 'checkout', 'main');
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'new main\n');
    git(repo, 'commit', '-am', 'new main');
    git(repo, 'push');
    git(repo, 'checkout', 'old-release');

    expect(() => runGuard(repo)).toThrow(/HEAD 与 origin\/main 不一致/);
  });

  it('工作树含未提交改动时拒绝部署', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n');

    expect(() => runGuard(repo)).toThrow(/工作树存在未提交改动/);
  });
});
