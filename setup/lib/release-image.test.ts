/**
 * `container/release-image.sh` decides which image a hardened install pulls, so
 * these run the real script inside scratch repositories: an official remote
 * whose main carries agent-images.json, and an install cloned from it.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, describe, expect, it } from 'vitest';

import { readReleaseImage } from './registry-state.js';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'container', 'release-image.sh');
const REF_A = 'reg.example.com/nanoclaw/agent@sha256:aaaa';
const REF_B = 'reg.example.com/nanoclaw/agent@sha256:bbbb';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim();
}

function commit(repo: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', file);
}

/** An official remote at `<tmp>/nanocoai/nanoclaw.git`, so the URL matches as upstream's does. */
function officialRemote(): { root: string; work: string; bare: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-image-'));
  scratch.push(root);
  const work = path.join(root, 'publisher');
  fs.mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  commit(work, 'README.md', 'v1\n');
  git(work, 'tag', '-a', 'v1.2.0', '-m', 'v1.2.0');
  const bare = path.join(root, 'nanocoai', 'nanoclaw.git');
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(root, 'clone', '-q', '--bare', work, bare);
  return { root, work, bare };
}

function publish(work: string, bare: string, list: Record<string, string>): void {
  commit(work, 'agent-images.json', `${JSON.stringify(list, null, 2)}\n`);
  git(work, 'push', '-q', bare, 'main');
}

/** An install cloned from the remote, with this branch's script copied in. */
function install(root: string, bare: string, remoteName = 'origin'): string {
  const dir = path.join(root, `install-${scratch.length}-${Math.random().toString(36).slice(2)}`);
  git(root, 'clone', '-q', '--origin', remoteName, bare, dir);
  fs.mkdirSync(path.join(dir, 'container'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'container', 'release-image.sh'));
  return dir;
}

function run(dir: string, ...args: string[]): string {
  return execFileSync('bash', [path.join(dir, 'container', 'release-image.sh'), ...args], {
    env: GIT_ENV,
    encoding: 'utf-8',
  }).trim();
}

describe('release-image.sh', () => {
  it('prints the image listed for the release this checkout is on', () => {
    const { root, work, bare } = officialRemote();
    publish(work, bare, { 'v1.2.0': REF_A });
    const dir = install(root, bare);
    git(dir, 'checkout', '-q', 'v1.2.0');

    expect(run(dir)).toBe(`v1.2.0 ${REF_A}`);
  });

  it('reads the list from main, so an image published after the release still counts', () => {
    const { root, work, bare } = officialRemote();
    const dir = install(root, bare);
    git(dir, 'checkout', '-q', 'v1.2.0');
    expect(run(dir)).toBe('');

    publish(work, bare, { 'v1.2.0': REF_A });
    expect(run(dir)).toBe('');
    expect(run(dir, '--fetch')).toBe(`v1.2.0 ${REF_A}`);
  });

  it('prefers an upstream remote, the one /update-nanoclaw uses', () => {
    const { root, work, bare } = officialRemote();
    publish(work, bare, { 'v1.2.0': REF_A });
    const dir = install(root, bare, 'upstream');

    expect(run(dir)).toBe(`v1.2.0 ${REF_A}`);
  });

  it('prints nothing when origin is not the official repository', () => {
    const { root, work, bare } = officialRemote();
    publish(work, bare, { 'v1.2.0': REF_A });
    const fork = path.join(root, 'someone', 'nanoclaw.git');
    fs.mkdirSync(path.dirname(fork), { recursive: true });
    git(root, 'clone', '-q', '--bare', bare, fork);
    const dir = install(root, fork);

    expect(run(dir)).toBe('');
  });

  it('skips release candidates, which never get an image', () => {
    const { root, work, bare } = officialRemote();
    commit(work, 'next.txt', 'rc\n');
    git(work, 'tag', '-a', 'v1.3.0-rc.1', '-m', 'rc');
    publish(work, bare, { 'v1.2.0': REF_A });
    git(work, 'push', '-q', bare, '--tags');
    const dir = install(root, bare);
    git(dir, 'checkout', '-q', 'v1.3.0-rc.1');

    expect(run(dir)).toBe(`v1.2.0 ${REF_A}`);
  });

  it('matches the release exactly, not a key that differs only where the dots are', () => {
    const { root, work, bare } = officialRemote();
    publish(work, bare, { v1x2x0: REF_B });
    const dir = install(root, bare);

    expect(run(dir)).toBe('');
  });

  it('falls back to the newest listed release in its history while its own image is not built', () => {
    const { root, work, bare } = officialRemote();
    commit(work, 'next.txt', 'v1.3.0\n');
    git(work, 'tag', '-a', 'v1.3.0', '-m', 'v1.3.0');
    publish(work, bare, { 'v1.2.0': REF_A });
    git(work, 'push', '-q', bare, '--tags');
    const dir = install(root, bare);
    git(dir, 'checkout', '-q', 'v1.3.0');

    expect(run(dir)).toBe(`v1.2.0 ${REF_A}`);
  });

  it('never takes an image for a release this checkout does not contain', () => {
    const { root, work, bare } = officialRemote();
    commit(work, 'next.txt', 'v1.3.0\n');
    git(work, 'tag', '-a', 'v1.3.0', '-m', 'v1.3.0');
    publish(work, bare, { 'v1.3.0': REF_B });
    git(work, 'push', '-q', bare, '--tags');
    const dir = install(root, bare);
    git(dir, 'checkout', '-q', 'v1.2.0');

    expect(run(dir)).toBe('');
  });
});

describe('readReleaseImage', () => {
  it('returns the reference the script prints', () => {
    const { root, work, bare } = officialRemote();
    publish(work, bare, { 'v1.2.0': REF_A });
    const dir = install(root, bare);

    expect(readReleaseImage(path.join(dir, 'container', 'release-image.sh'))).toBe(REF_A);
  });

  it('is undefined when nothing is listed', () => {
    const { root, bare } = officialRemote();
    const dir = install(root, bare);

    expect(readReleaseImage(path.join(dir, 'container', 'release-image.sh'))).toBeUndefined();
  });
});
