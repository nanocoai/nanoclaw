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

function runGuard(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('/bin/bash', [guardScript, repo], {
    encoding: 'utf8',
    env,
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
    const updater = path.join(path.dirname(repo), 'updater');
    git(path.dirname(repo), 'clone', '-b', 'main', path.join(path.dirname(repo), 'remote.git'), updater);
    git(updater, 'config', 'user.email', 'test@example.com');
    git(updater, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(updater, 'tracked.txt'), 'new main\n');
    git(updater, 'commit', '-am', 'new main');
    git(updater, 'push');

    expect(() => runGuard(repo)).toThrow(/HEAD 与 origin\/main 不一致/);
  });

  it('工作树含未提交改动时拒绝部署', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'dirty\n');

    expect(() => runGuard(repo)).toThrow(/工作树存在未提交改动/);
  });

  it('工作树含未跟踪文件时拒绝部署', () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'dirty\n');

    expect(() => runGuard(repo)).toThrow(/工作树存在未提交改动/);
  });

  it('环境变量不能覆盖固定的 origin/main 基准', () => {
    const repo = makeRepo();
    const updater = path.join(path.dirname(repo), 'updater');
    git(path.dirname(repo), 'clone', '-b', 'main', path.join(path.dirname(repo), 'remote.git'), updater);
    git(updater, 'config', 'user.email', 'test@example.com');
    git(updater, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(updater, 'tracked.txt'), 'new main\n');
    git(updater, 'commit', '-am', 'new main');
    git(updater, 'push');

    expect(() =>
      runGuard(repo, { ...process.env, NANOCLAW_DEPLOY_REF: 'HEAD' }),
    ).toThrow(/HEAD 与 origin\/main 不一致/);
  });

  it('远端不可用时拒绝部署', () => {
    const repo = makeRepo();
    git(repo, 'remote', 'set-url', 'origin', path.join(repo, 'missing.git'));

    expect(() => runGuard(repo)).toThrow();
  });
});

describe('重启脚本部署顺序', () => {
  it('守卫失败发生在编译和进程重启之前', () => {
    const restartScript = fs.readFileSync(path.resolve('restart.sh'), 'utf8');
    const guardIndex = restartScript.indexOf('check-deploy-state.sh');
    const buildIndex = restartScript.indexOf('npm run build');
    const restartIndex = restartScript.indexOf('\nlaunchctl kickstart');

    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(buildIndex);
    expect(guardIndex).toBeLessThan(restartIndex);
  });
});
