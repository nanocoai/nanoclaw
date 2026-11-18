import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AheadOfReleaseError, readChannelSetting, resolveUpdateTarget } from '../../scripts/update/channel.js';
import { isUpgradeCurrent, writeUpgradeState } from '../../src/upgrade-state.js';
import { upsertEnvVar } from '../set-env.js';
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
function helper(fn: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', ['-c', 'set -euo pipefail; source "$0"; "$@"', HELPER, fn, ...args], {
      encoding: 'utf8',
      env: GIT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    const failure = err as { status: number; stderr: string };
    return { status: failure.status, stdout: '', stderr: failure.stderr };
  }
}

const decide = (root: string, requested = '', tty = '1') =>
  helper('release_checkout_decide', root, requested, tty).stdout;

/** A fresh clone whose main is past v2.4.0 and v2.5.0-rc.1, or exactly on v2.4.0. */
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
  it('asks a fresh clone of main which channel to follow, naming the newest tag of each', () => {
    expect(decide(freshClone().install)).toBe('offer v2.4.0 v2.5.0-rc.1');
  });

  it("installs the given channel's release without asking, and only on a terminal", () => {
    const { install } = freshClone();
    expect(decide(install, ' Stable ')).toBe('switch stable v2.4.0');
    expect(decide(install, 'beta')).toBe('switch beta v2.5.0-rc.1');
    expect(decide(install, 'stable', '0')).toBe('notice stable v2.4.0');
    expect(decide(install, 'beta', '0')).toBe('notice beta v2.5.0-rc.1');
  });

  it('installs a channel saved in .env without asking; a request overrides it', () => {
    const { install } = freshClone();
    fs.writeFileSync(path.join(install, '.env'), 'NANOCLAW_UPDATE_CHANNEL=beta\n');
    expect(decide(install)).toBe('switch beta v2.5.0-rc.1');
    fs.writeFileSync(path.join(install, '.env'), 'NANOCLAW_UPDATE_CHANNEL=edge\n');
    expect(decide(install, 'stable')).toBe('switch stable v2.4.0');
  });

  it("never moves a fork, whose main may carry its owner's changes", () => {
    const { install } = freshClone({ official: false });
    expect(decide(install)).toBe('notice stable v2.4.0');
    expect(decide(install, 'stable')).toBe('notice stable v2.4.0');

    const lookalike = freshClone({ official: false }).install;
    git(lookalike, ['config', 'remote.origin.url', 'https://github.com/notnanocoai/nanoclaw.git']);
    expect(decide(lookalike, 'stable')).toBe('notice stable v2.4.0');
  });

  it('never asks without a terminal', () => {
    expect(decide(freshClone().install, '', '0')).toBe('notice stable v2.4.0');
  });

  it('asks even when main is on the release, and stays put once the channel is known', () => {
    const { install } = freshClone({ ahead: false });
    expect(decide(install)).toBe('offer v2.4.0 v2.4.0');
    expect(decide(install, '', '0')).toBe('none');
    expect(decide(install, 'stable')).toBe('none');
    expect(decide(install, 'beta')).toBe('none');
  });

  it('leaves the edge channel alone, from the request or from .env', () => {
    const { install } = freshClone();
    expect(decide(install, 'edge')).toBe('none');
    fs.writeFileSync(path.join(install, '.env'), 'OTHER=1\nNANOCLAW_UPDATE_CHANNEL="edge"\n');
    expect(decide(install)).toBe('none');
  });

  it.each([
    ['NANOCLAW_UPDATE_CHANNEL=edge\nNANOCLAW_UPDATE_CHANNEL=\n', 'edge'],
    ['NANOCLAW_UPDATE_CHANNEL=stable\nNANOCLAW_UPDATE_CHANNEL=edge\n', 'edge'],
    ["  NANOCLAW_UPDATE_CHANNEL = 'Edge'\r\n", 'edge'],
  ])('reads %j as the updater does', (env, channel) => {
    const { install } = freshClone();
    fs.writeFileSync(path.join(install, '.env'), env);
    expect(readChannelSetting(install)).toBe(channel);
    expect(helper('release_checkout_saved_channel', install).stdout).toBe(channel);
    expect(decide(install)).toBe('none');
  });

  it('asks again over a value the updater rejects', () => {
    const { install } = freshClone();
    fs.writeFileSync(path.join(install, '.env'), 'NANOCLAW_UPDATE_CHANNEL="ed ge"\n');
    expect(() => readChannelSetting(install)).toThrow('Unknown update channel');
    expect(helper('release_checkout_saved_channel', install).stdout).toBe('ed ge');
    expect(decide(install)).toBe('offer v2.4.0 v2.5.0-rc.1');
  });

  it('ignores a .env without the channel', () => {
    const { install } = freshClone();
    fs.writeFileSync(path.join(install, '.env'), 'OTHER=1\n');
    expect(decide(install)).toBe('offer v2.4.0 v2.5.0-rc.1');
  });

  it('leaves an existing install alone', () => {
    const { install } = freshClone();
    fs.mkdirSync(path.join(install, 'data'));
    fs.writeFileSync(path.join(install, 'data', 'upgrade-state.json'), '{}\n');
    expect(decide(install)).toBe('none');
    expect(decide(install, 'stable')).toBe('none');
  });

  it('still asks after a first launch that only recorded the install id', () => {
    const { install } = freshClone();
    fs.mkdirSync(path.join(install, 'data'));
    fs.writeFileSync(path.join(install, 'data', 'install-id'), 'abc');
    expect(decide(install)).toBe('offer v2.4.0 v2.5.0-rc.1');
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

  it('does nothing without a stable release or a Git checkout', () => {
    const untagged = temp('release-untagged-');
    git(untagged, ['init', '-q', '-b', 'main']);
    commit(untagged, 'first');
    git(untagged, ['tag', '-a', 'v2.5.0-rc.1', '-m', 'rc']);
    expect(decide(untagged)).toBe('none');
    expect(decide(temp('release-plain-'))).toBe('none');
  });

  it('reports an unknown channel instead of guessing', () => {
    expect(decide(freshClone().install, 'nightly')).toBe('invalid nightly');
    expect(decide(freshClone().install, 'sta ble')).toBe('invalid sta ble');
  });
});

describe('release checkout tag pick', () => {
  const updaterTag = (install: string, channel: 'stable' | 'beta') => {
    try {
      return resolveUpdateTarget({ projectRoot: install, remote: 'origin', channel }).tag;
    } catch (err) {
      // The tag it would move to, refused only because main is past it.
      if (err instanceof AheadOfReleaseError) return err.tag;
      throw err;
    }
  };

  it.each([
    [['v2.4.0', 'v2.5.0-beta.1', 'v2.5.0-beta.2', 'v2.5.0-rc.1']],
    [['v2.5.0-rc.1', 'v2.5.0', 'v2.4.1']],
    [['v2.4.0', 'v2.10.0-rc.9', 'v2.10.0-rc.10', 'v2.9.0']],
    [['v2.4.0', 'v2026.10.0', 'v2026.11.0-rc.2']],
    [['v2.4.0', 'v2.5.0-beta.0', 'v2.5.0-alpha.1', 'v2.5.0-rc.01', 'pre-update-x']],
  ])('picks what the updater picks from %j', (tags) => {
    const seed = temp('release-tags-');
    git(seed, ['init', '-q', '-b', 'main']);
    for (const tag of tags) {
      commit(seed, tag);
      git(seed, ['tag', '-a', tag, '-m', tag]);
    }
    commit(seed, 'main tip');
    git(seed, ['tag', 'v99.0.0']); // lightweight: never a release
    const install = path.join(temp('release-install-'), 'nanoclaw');
    git(path.dirname(install), ['clone', '-q', seed, install]);

    for (const channel of ['stable', 'beta'] as const) {
      expect(helper('release_checkout_newest_tag', install, channel).stdout).toBe(updaterTag(install, channel));
    }
  });
});

describe('release checkout question', () => {
  it('names the newest tag of each channel', () => {
    const menu = helper('release_checkout_menu', 'v2.4.0', 'v2.5.0-rc.1').stdout;
    expect(menu).toContain('1) stable  published releases, now v2.4.0 (recommended)');
    expect(menu).toContain('2) beta    release candidates too, now v2.5.0-rc.1');
    expect(menu).toContain('3) edge    the newest code from main');
    expect(helper('release_checkout_menu', 'v2.4.0', 'v2.4.0').stdout).toContain('now v2.4.0 (no newer one yet)');
  });

  it.each([
    ['', 'stable'],
    ['1', 'stable'],
    [' 2 ', 'beta'],
    ['3', 'edge'],
    ['Beta', 'beta'],
    ['edge', 'edge'],
    ['22', 'stable'],
  ])('takes %j as %s', (answer, channel) => {
    expect(helper('release_checkout_answer', answer).stdout).toBe(channel);
  });
});

describe('release checkout save', () => {
  const env = (root: string) => path.join(root, '.env');

  it('creates a private .env holding the channel', () => {
    const root = temp('release-save-');
    expect(helper('release_checkout_save_channel', root, 'beta').status).toBe(0);
    expect(fs.readFileSync(env(root), 'utf8')).toBe('NANOCLAW_UPDATE_CHANNEL=beta\n');
    expect(fs.statSync(env(root)).mode & 0o777).toBe(0o600);
    expect(readChannelSetting(root)).toBe('beta');
  });

  it.each([
    '',
    'OTHER=1',
    'OTHER=1\n',
    'A=1\nNANOCLAW_UPDATE_CHANNEL=edge\nB=2\n  NANOCLAW_UPDATE_CHANNEL = "stable"\r\n# NANOCLAW_UPDATE_CHANNEL=edge\n',
  ])('writes %j as setup writes it, keeping the file mode', (before) => {
    const shell = temp('release-save-');
    const setup = temp('release-save-');
    for (const root of [shell, setup]) {
      fs.writeFileSync(env(root), before);
      fs.chmodSync(env(root), 0o640);
    }
    expect(helper('release_checkout_save_channel', shell, 'beta').status).toBe(0);
    upsertEnvVar('NANOCLAW_UPDATE_CHANNEL', 'beta', setup);
    expect(fs.readFileSync(env(shell), 'utf8')).toBe(fs.readFileSync(env(setup), 'utf8'));
    expect(fs.statSync(env(shell)).mode & 0o777).toBe(0o640);
    expect(readChannelSetting(shell)).toBe('beta');
  });
});

describe('release checkout switch', () => {
  const resolve = (install: string, channel: 'stable' | 'beta') =>
    resolveUpdateTarget({ projectRoot: install, remote: 'origin', channel });

  it('lands on the release, on a branch the updater resolves stable from', () => {
    const { install, release } = freshClone();
    expect(() => resolve(install, 'stable')).toThrow(AheadOfReleaseError);

    expect(helper('release_checkout_switch', install, 'stable', 'v2.4.0').status).toBe(0);
    expect(git(install, ['rev-parse', 'HEAD'])).toBe(release);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('stable');
    expect(decide(install)).toBe('none');
    expect(resolve(install, 'stable')).toMatchObject({ channel: 'stable', tag: 'v2.4.0' });
  });

  it('lands beta on the newest release candidate, which the updater resolves', () => {
    const { install } = freshClone();
    expect(() => resolve(install, 'beta')).toThrow(AheadOfReleaseError);

    expect(helper('release_checkout_switch', install, 'beta', 'v2.5.0-rc.1').status).toBe(0);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('beta');
    expect(decide(install, 'beta')).toBe('none');
    expect(resolve(install, 'beta')).toMatchObject({ channel: 'beta', tag: 'v2.5.0-rc.1' });
  });

  it('keeps the upgrade marker current and stable resolvable after setup commits on top', () => {
    const { install } = freshClone();
    helper('release_checkout_switch', install, 'stable', 'v2.4.0');

    writeUpgradeState({ via: 'setup', projectRoot: install });
    const before = snapshotTree(install);
    fs.writeFileSync(path.join(install, 'skill-payload.txt'), 'installed\n');
    expect(commitSetupChanges(install, before, 'setup: apply add-example')).toEqual({
      committed: ['skill-payload.txt'],
    });

    expect(isUpgradeCurrent(install)).toBe(true);
    expect(resolve(install, 'stable')).toMatchObject({ channel: 'stable', tag: 'v2.4.0' });
  });

  it('fails without moving HEAD when the branch name is taken, and says why', () => {
    const { install } = freshClone();
    git(install, ['branch', 'stable']);
    const head = git(install, ['rev-parse', 'HEAD']);
    const result = helper('release_checkout_switch', install, 'stable', 'v2.4.0');
    expect(result.status).not.toBe(0);
    // Git's wording depends on the locale; the branch name does not.
    expect(result.stderr).toContain('stable');
    expect(git(install, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  });
});

/**
 * The real nanoclaw.sh on main, in a clone whose bootstrap and setup hand-off are stubs.
 * Its releases predate the channel setting: their nanoclaw.sh only reports how it was started.
 */
function entrypointClone() {
  const seed = temp('entry-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'data/\n.env\nlogs/\nbootstrap-ran\n');
  for (const tag of ['v2.4.0', 'v2.5.0-rc.1']) {
    fs.writeFileSync(
      path.join(seed, 'nanoclaw.sh'),
      `echo "RELEASE ${tag} args=[$*] channel=[\${NANOCLAW_UPDATE_CHANNEL:-}]"\n`,
    );
    commit(seed, tag);
    git(seed, ['tag', '-a', tag, '-m', tag]);
  }
  const files = [
    'nanoclaw.sh',
    'setup/lib/release-checkout.sh',
    'setup/lib/diagnostics.sh',
    'setup/lib/sudo-preflight.sh',
    'setup/lib/node-version.sh',
    'setup/lib/jq.sh',
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), file), path.join(seed, file));
  }
  fs.mkdirSync(path.join(seed, 'assets'));
  fs.writeFileSync(path.join(seed, 'assets/setup-splash.txt'), 'splash\n');
  fs.writeFileSync(path.join(seed, 'setup.sh'), 'touch bootstrap-ran\n');
  commit(seed, 'main tip');

  const install = path.join(temp('entry-install-'), 'nanoclaw');
  git(path.dirname(install), ['clone', '-q', seed, install]);
  // Official, so only a missing terminal keeps a run on main.
  markOfficial(install, seed);
  const bin = temp('entry-bin-');
  fs.writeFileSync(
    path.join(bin, 'pnpm'),
    '#!/bin/sh\necho "HANDOFF args=[$*] channel=[${NANOCLAW_UPDATE_CHANNEL:-}]"\n',
    { mode: 0o755 },
  );
  // nanoclaw.sh stops on a Node below its minimum; the runner's own Node must not decide these tests.
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v26.12.1\n', { mode: 0o755 });
  const env = { ...GIT_ENV, NANOCLAW_NO_DIAGNOSTICS: '1', PATH: `${bin}:${process.env.PATH}` };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    try {
      const stdout = execFileSync('bash', ['nanoclaw.sh', ...args], {
        cwd: install,
        encoding: 'utf8',
        env: { ...env, ...extra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout };
    } catch (err) {
      const failure = err as { status: number; stdout: string };
      return { status: failure.status, stdout: failure.stdout };
    }
  };
  /** On a real terminal (util-linux or BSD `script`), typing `answer` at the channel question. */
  const runOnTerminal = (args: string[], answer: string) =>
    new Promise<string>((resolve, reject) => {
      const end = 'TERMINAL-RUN-ENDED';
      const quoted = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
      const command = `${['bash', 'nanoclaw.sh', ...args].map(quoted).join(' ')}; echo ${end}`;
      const terminal =
        process.platform === 'darwin'
          ? `script -q /dev/null bash -c ${quoted(command)}`
          : `script -q -e -c ${quoted(command)} /dev/null`;
      // `cat |` gives script a real pipe (BSD script rejects Node's socket), open
      // until the run ends: BSD script drops early input and turns EOF into ^D.
      const child = spawn('sh', ['-c', `cat | ${terminal}`], { cwd: install, env, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
      let stdout = '';
      let answered = false;
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (!answered && stdout.includes('Choose [1/2/3]')) {
          answered = true;
          child.stdin.write(answer);
        }
        if (stdout.includes(end)) child.stdin.end();
      });
      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(timer);
        resolve(stdout.replace(/\r/g, ''));
      });
    });
  const tagCommit = (tag: string) => git(install, ['rev-parse', `refs/tags/${tag}^{commit}`]);
  return { install, run, runOnTerminal, tagCommit, head: git(install, ['rev-parse', 'HEAD']) };
}

const savedChannel = (install: string) =>
  fs.existsSync(path.join(install, '.env')) ? fs.readFileSync(path.join(install, '.env'), 'utf8') : null;

// Root gets nanoclaw.sh's own "running as root" prompt, which needs a terminal.
describe.skipIf(process.getuid?.() === 0)('nanoclaw.sh without a terminal', () => {
  const onMain = (install: string, head: string) => {
    expect(git(install, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
  };

  it('keeps the checkout and saves nothing, says how to follow main, and hands off unchanged', () => {
    const { install, run, head } = entrypointClone();
    const result = run(['--template-path', 'sales/sdr']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Which updates');
    expect(result.stdout).toContain('newer than the latest stable release (v2.4.0)');
    expect(result.stdout).toContain('set-channel --channel edge');
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto --template-path sales/sdr] channel=[]');
    expect(savedChannel(install)).toBeNull();
    onMain(install, head);
  });

  it('does not switch for an explicit channel either, and forwards the flag', () => {
    const { install, run, head } = entrypointClone();
    const result = run(['--update-channel', 'beta']);
    expect(result.stdout).toContain('newer than the latest beta release (v2.5.0-rc.1)');
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto --update-channel beta] channel=[]');
    onMain(install, head);
  });

  it('stays quiet on the edge channel', () => {
    const { install, run, head } = entrypointClone();
    const result = run([], { NANOCLAW_UPDATE_CHANNEL: 'edge' });
    expect(result.stdout).not.toContain('newer than');
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

describe.runIf(['linux', 'darwin'].includes(process.platform) && process.getuid?.() !== 0)(
  'nanoclaw.sh on a terminal',
  { timeout: 30_000 },
  () => {
    it.each([
      ['\n', 'stable', 'v2.4.0'],
      ['2\n', 'beta', 'v2.5.0-rc.1'],
    ])('answer %j installs the %s release %s, saved before it starts', async (answer, channel, tag) => {
      const { install, runOnTerminal, tagCommit } = entrypointClone();
      const stdout = await runOnTerminal(['--template-path', 'sales/sdr'], answer);
      expect(stdout).toContain('Which updates should this install follow?');
      expect(stdout).toContain(`Installing ${tag} (branch: ${channel}).`);
      // The release's own nanoclaw.sh, which knows nothing about channels, got the rest.
      expect(stdout).toContain(`RELEASE ${tag} args=[--template-path sales/sdr] channel=[${channel}]`);
      expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe(channel);
      expect(git(install, ['rev-parse', 'HEAD'])).toBe(tagCommit(tag));
      expect(savedChannel(install)).toBe(`NANOCLAW_UPDATE_CHANNEL=${channel}\n`);
      expect(readChannelSetting(install)).toBe(channel);
    });

    it('answer 3 keeps main and saves edge', async () => {
      const { install, runOnTerminal, head } = entrypointClone();
      const stdout = await runOnTerminal([], '3\n');
      expect(stdout).toContain('Which updates should this install follow?');
      expect(stdout).not.toContain('newer than');
      expect(stdout).toContain('HANDOFF args=[--silent run setup:auto] channel=[edge]');
      expect(git(install, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
      expect(savedChannel(install)).toBe('NANOCLAW_UPDATE_CHANNEL=edge\n');
    });

    it('takes the channel from the flag without asking', async () => {
      const { install, runOnTerminal, tagCommit } = entrypointClone();
      const stdout = await runOnTerminal(['--update-channel', 'beta', '--template-path', 'sales/sdr'], '');
      expect(stdout).not.toContain('Which updates');
      expect(stdout).toContain('RELEASE v2.5.0-rc.1 args=[--template-path sales/sdr] channel=[beta]');
      expect(git(install, ['rev-parse', 'HEAD'])).toBe(tagCommit('v2.5.0-rc.1'));
      expect(savedChannel(install)).toBe('NANOCLAW_UPDATE_CHANNEL=beta\n');
    });
  },
);
