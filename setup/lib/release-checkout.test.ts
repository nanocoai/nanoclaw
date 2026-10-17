import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AheadOfReleaseError, resolveUpdateTarget } from '../../scripts/update/channel.js';
import { isUpgradeCurrent, writeUpgradeState } from '../../src/upgrade-state.js';
import { commitSetupChanges, snapshotTree } from './setup-commit.js';

const HELPER = path.join(process.cwd(), 'setup/lib/release-checkout.sh');
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const OFFICIAL_URL = 'https://github.com/nanocoai/nanoclaw.git';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(root: string, message: string): string {
  fs.writeFileSync(path.join(root, 'log.txt'), `${message}\n`, { flag: 'a' });
  git(root, ['add', '--all']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

/** Runs one helper function the way nanoclaw.sh does: sourced, under `set -euo pipefail`. */
function helper(fn: string, ...args: string[]): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bash', ['-c', 'set -euo pipefail; source "$0"; "$@"', HELPER, fn, ...args], {
      encoding: 'utf8',
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout.trim() };
  } catch (err) {
    return { status: (err as { status: number }).status, stdout: '' };
  }
}

const decide = (root: string, requested = '', tty = '1') =>
  helper('release_checkout_decide', root, requested, tty).stdout;

/** A fresh clone of a repo whose main is one commit past v2.4.0 (or exactly on it). */
function freshClone(options: { ahead?: boolean; official?: boolean } = {}) {
  const seed = temp('release-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'data/\n.env\nlogs/\n');
  fs.writeFileSync(path.join(seed, 'package.json'), '{"version":"2.4.0"}\n');
  commit(seed, 'v2.3.0');
  git(seed, ['tag', '-a', 'v2.3.0', '-m', 'v2.3.0']);
  const release = commit(seed, 'v2.4.0');
  git(seed, ['tag', '-a', 'v2.4.0', '-m', 'v2.4.0']);
  if (options.ahead ?? true) {
    commit(seed, 'rc');
    git(seed, ['tag', '-a', 'v2.5.0-rc.1', '-m', 'rc']);
    commit(seed, 'main tip');
    git(seed, ['tag', 'v9.9.9']); // lightweight: never a release
  }
  const install = path.join(temp('release-install-'), 'nanoclaw');
  git(path.dirname(install), ['clone', '-q', seed, install]);
  if (options.official ?? true) markOfficial(install, seed);
  return { seed, install, release };
}

/** Name the official repository as origin while Git keeps fetching from the local seed. */
function markOfficial(install: string, seed: string): void {
  git(install, ['config', `url.${seed}.insteadOf`, OFFICIAL_URL]);
  git(install, ['config', 'remote.origin.url', OFFICIAL_URL]);
}

describe('release checkout decision', () => {
  it('offers the latest release to a fresh clone of main that is past it', () => {
    expect(decide(freshClone().install)).toBe('offer v2.4.0');
  });

  it('switches without asking when the channel was given, and only on a terminal', () => {
    const { install } = freshClone();
    expect(decide(install, ' Stable ')).toBe('switch v2.4.0');
    expect(decide(install, 'stable', '0')).toBe('notice v2.4.0');
  });

  it('keeps main for beta when the release cannot save that choice', () => {
    expect(decide(freshClone().install, 'beta')).toBe('notice v2.4.0');

    const { seed } = freshClone();
    git(seed, ['checkout', '-q', '-B', 'main', 'v2.4.0']);
    fs.mkdirSync(path.join(seed, 'setup/lib'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'setup/lib/release-checkout.sh'), '');
    commit(seed, 'v2.6.0');
    git(seed, ['tag', '-a', 'v2.6.0', '-m', 'v2.6.0']);
    commit(seed, 'main tip');
    const install = path.join(temp('release-install-'), 'nanoclaw');
    git(path.dirname(install), ['clone', '-q', seed, install]);
    markOfficial(install, seed);
    expect(decide(install, 'beta')).toBe('switch v2.6.0');
  });

  it("never moves a fork, whose main may carry its owner's changes", () => {
    const { install } = freshClone({ official: false });
    expect(decide(install)).toBe('notice v2.4.0');
    expect(decide(install, 'stable')).toBe('notice v2.4.0');

    const lookalike = freshClone({ official: false }).install;
    git(lookalike, ['config', 'remote.origin.url', 'https://github.com/notnanocoai/nanoclaw.git']);
    expect(decide(lookalike, 'stable')).toBe('notice v2.4.0');
  });

  it('never offers without a terminal', () => {
    expect(decide(freshClone().install, '', '0')).toBe('notice v2.4.0');
  });

  it('leaves an install already on the release alone', () => {
    expect(decide(freshClone({ ahead: false }).install)).toBe('none');
    expect(decide(freshClone({ ahead: false }).install, '', '0')).toBe('none');
  });

  it('leaves the edge channel alone, from the request or from .env', () => {
    const { install } = freshClone();
    expect(decide(install, 'edge')).toBe('none');
    fs.writeFileSync(path.join(install, '.env'), 'OTHER=1\nNANOCLAW_UPDATE_CHANNEL="edge"\n');
    expect(decide(install)).toBe('none');
    // v2.4.0 predates the setting and could not replace the saved edge.
    expect(decide(install, 'stable')).toBe('notice v2.4.0');
  });

  it('ignores a .env without the channel', () => {
    const { install } = freshClone();
    fs.writeFileSync(path.join(install, '.env'), 'OTHER=1\n');
    expect(decide(install)).toBe('offer v2.4.0');
  });

  it('leaves an existing install alone', () => {
    const { install } = freshClone();
    fs.mkdirSync(path.join(install, 'data'));
    fs.writeFileSync(path.join(install, 'data', 'upgrade-state.json'), '{}\n');
    expect(decide(install)).toBe('none');
    expect(decide(install, 'stable')).toBe('none');
  });

  it('still offers after a first launch that only recorded the install id', () => {
    const { install } = freshClone();
    fs.mkdirSync(path.join(install, 'data'));
    fs.writeFileSync(path.join(install, 'data', 'install-id'), 'abc');
    expect(decide(install)).toBe('offer v2.4.0');
  });

  it('leaves a working copy alone: another branch, local edits, or local commits', () => {
    const branch = freshClone().install;
    git(branch, ['checkout', '-q', '-b', 'feature']);
    expect(decide(branch)).toBe('none');

    const edited = freshClone().install;
    fs.writeFileSync(path.join(edited, 'log.txt'), 'edited\n');
    expect(decide(edited)).toBe('none');

    const committed = freshClone().install;
    commit(committed, 'local customization');
    expect(decide(committed)).toBe('none');
  });

  it('does nothing when there is no release tag or no Git checkout', () => {
    const untagged = temp('release-untagged-');
    git(untagged, ['init', '-q', '-b', 'main']);
    commit(untagged, 'first');
    expect(decide(untagged)).toBe('none');
    expect(decide(temp('release-plain-'))).toBe('none');
  });

  it('reports an unknown channel instead of guessing', () => {
    expect(decide(freshClone().install, 'nightly')).toBe('invalid nightly');
    expect(decide(freshClone().install, 'sta ble')).toBe('invalid sta ble');
  });
});

describe('release checkout switch', () => {
  const resolveStable = (install: string) =>
    resolveUpdateTarget({ projectRoot: install, remote: 'origin', channel: 'stable' });

  it('lands on the release, on a branch the updater resolves stable from', () => {
    const { install, release } = freshClone();
    expect(() => resolveStable(install)).toThrow(AheadOfReleaseError);

    expect(helper('release_checkout_switch', install, 'v2.4.0').status).toBe(0);
    expect(git(install, ['rev-parse', 'HEAD'])).toBe(release);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('stable');
    expect(decide(install)).toBe('none');
    expect(resolveStable(install)).toMatchObject({ channel: 'stable', tag: 'v2.4.0' });
  });

  it('keeps the upgrade marker current and stable resolvable after setup commits on top', () => {
    const { install } = freshClone();
    helper('release_checkout_switch', install, 'v2.4.0');

    writeUpgradeState({ via: 'setup', projectRoot: install });
    const before = snapshotTree(install);
    fs.writeFileSync(path.join(install, 'skill-payload.txt'), 'installed\n');
    expect(commitSetupChanges(install, before, 'setup: apply add-example')).toEqual({
      committed: ['skill-payload.txt'],
    });

    expect(isUpgradeCurrent(install)).toBe(true);
    expect(resolveStable(install)).toMatchObject({ channel: 'stable', tag: 'v2.4.0' });
  });

  it('fails without moving HEAD when the branch name is taken', () => {
    const { install } = freshClone();
    git(install, ['branch', 'stable']);
    const head = git(install, ['rev-parse', 'HEAD']);
    expect(helper('release_checkout_switch', install, 'v2.4.0').status).not.toBe(0);
    expect(git(install, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });
});

/** The real nanoclaw.sh in a clone whose bootstrap and setup hand-off are stubs. */
function entrypointClone() {
  const seed = temp('entry-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  for (const file of ['nanoclaw.sh', 'setup/lib/release-checkout.sh', 'setup/lib/diagnostics.sh']) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), file), path.join(seed, file));
  }
  fs.mkdirSync(path.join(seed, 'assets'));
  fs.writeFileSync(path.join(seed, 'assets/setup-splash.txt'), 'splash\n');
  fs.writeFileSync(path.join(seed, 'setup.sh'), 'touch bootstrap-ran\n');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'data/\n.env\nlogs/\nbootstrap-ran\n');
  commit(seed, 'v2.4.0');
  git(seed, ['tag', '-a', 'v2.4.0', '-m', 'v2.4.0']);
  commit(seed, 'main tip');

  const install = path.join(temp('entry-install-'), 'nanoclaw');
  git(path.dirname(install), ['clone', '-q', seed, install]);
  const bin = temp('entry-bin-');
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/bin/sh\necho "HANDOFF args=[$*] channel=[${NANOCLAW_UPDATE_CHANNEL:-}]"\n',
    { mode: 0o755 },
  );
  const run = (args: string[], env: Record<string, string> = {}) => {
    try {
      const stdout = execFileSync('bash', ['nanoclaw.sh', ...args], {
        cwd: install,
        encoding: 'utf8',
        env: { ...GIT_ENV, NANOCLAW_NO_DIAGNOSTICS: '1', PATH: `${bin}:${process.env.PATH}`, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (err) {
      const failure = err as { status: number; stdout: string };
      return { status: failure.status, stdout: failure.stdout };
    }
  };
  return { install, run, head: git(install, ['rev-parse', 'HEAD']) };
}

// Root gets nanoclaw.sh's own "running as root" prompt, which needs a terminal.
describe.skipIf(process.getuid?.() === 0)('nanoclaw.sh without a terminal', () => {
  const onMain = (install: string, head: string) => {
    expect(git(install, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  };

  it('keeps the checkout, says how to follow main, and hands off unchanged', () => {
    const { install, run, head } = entrypointClone();
    const result = run(['--template-path', 'sales/sdr']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('newer than the latest release (v2.4.0)');
    expect(result.stdout).toContain('set-channel --channel edge');
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto --template-path sales/sdr] channel=[]');
    onMain(install, head);
  });

  it('does not switch for an explicit stable channel either, and forwards the flag', () => {
    const { install, run, head } = entrypointClone();
    const result = run(['--update-channel', 'stable']);
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto --update-channel stable] channel=[]');
    onMain(install, head);
  });

  it('stays quiet on the edge channel', () => {
    const { install, run, head } = entrypointClone();
    const result = run([], { NANOCLAW_UPDATE_CHANNEL: 'edge' });
    expect(result.stdout).not.toContain('latest release');
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto] channel=[edge]');
    onMain(install, head);
  });

  it('ignores a channel after the end-of-options marker, like setup does', () => {
    const { run } = entrypointClone();
    const result = run(['--', '--update-channel', 'nightly']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto -- --update-channel nightly] channel=[]');
  });

  it('stops on an unknown channel before installing anything', () => {
    const { install, run } = entrypointClone();
    const result = run(['--update-channel=nightly']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('unknown update channel "nightly"');
    expect(fs.existsSync(path.join(install, 'bootstrap-ran'))).toBe(false);
  });
});
