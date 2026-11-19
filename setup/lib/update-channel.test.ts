import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { AheadOfReleaseError, readChannelSetting, resolveUpdateTarget } from '../../scripts/update/channel.js';

const HELPER = path.join(process.cwd(), 'setup/lib/update-channel.sh');
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

// A script file, not `bash -c`: the paths stay plain arguments.
const RUNNER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'channel-helper-')), 'run.sh');
fs.writeFileSync(RUNNER, 'set -euo pipefail\nsource "$1"\nshift\n"$@"\n');
afterAll(() => fs.rmSync(path.dirname(RUNNER), { recursive: true, force: true }));

/** Runs one helper function the way nanoclaw.sh does: sourced, under `set -euo pipefail`. */
function helper(fn: string, ...args: string[]): { stdout: string; raw: string } {
  const raw = execFileSync('bash', [RUNNER, HELPER, fn, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout: raw.trim(), raw };
}

const decide = (root: string, requested = '') => helper('update_channel_decide', root, requested).stdout;

/**
 * The official repository as the release workflow leaves it: `stable` on the newest
 * release, `beta` on the newest release candidate, `main` past both (or exactly on
 * the release). `files` are committed before the first tag.
 */
function officialSeed(options: { ahead?: boolean; files?: Record<string, string> } = {}): string {
  const seed = temp('channel-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'data/\n.env\nlogs/\nbootstrap-ran\n');
  for (const [file, content] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content);
  }
  commit(seed, 'v2.3.0');
  git(seed, ['tag', '-a', 'v2.3.0', '-m', 'v2.3.0']);
  commit(seed, 'v2.4.0');
  git(seed, ['tag', '-a', 'v2.4.0', '-m', 'v2.4.0']);
  git(seed, ['branch', 'stable']);
  if (options.ahead ?? true) {
    commit(seed, 'rc');
    git(seed, ['tag', '-a', 'v2.5.0-rc.1', '-m', 'rc']);
    git(seed, ['branch', 'beta']);
    commit(seed, 'main tip');
    git(seed, ['tag', 'v9.9.9']); // lightweight: never a release
  } else {
    git(seed, ['branch', 'beta']);
  }
  return seed;
}

/** A fresh clone of `branch`, with origin named as the official repository unless `official` is false. */
function clone(seed: string, branch = 'main', options: { official?: boolean; shallow?: boolean } = {}): string {
  const install = path.join(temp('channel-install-'), 'nanoclaw');
  const source = `file://${seed}`;
  const depth = options.shallow ? ['--depth', '1'] : [];
  git(path.dirname(install), ['clone', '-q', '--branch', branch, ...depth, source, install]);
  if (options.official ?? true) {
    // Git keeps fetching from the local seed.
    git(install, ['config', `url.${source}.insteadOf`, OFFICIAL_URL]);
    git(install, ['config', 'remote.origin.url', OFFICIAL_URL]);
  }
  return install;
}

describe('update channel decision', () => {
  it('records the channel of the cloned branch, and stable for main', () => {
    const seed = officialSeed();
    expect(decide(clone(seed, 'stable'))).toBe('record stable');
    expect(decide(clone(seed, 'beta'))).toBe('record beta');
    // The updater's own default: past every release, its first update waits.
    expect(decide(clone(seed, 'main'))).toBe('record-ahead stable');
    expect(decide(clone(officialSeed({ ahead: false }), 'main'))).toBe('record-main stable');
  });

  it('records it for a shallow clone too, which has no history or older tags', () => {
    const install = clone(officialSeed(), 'stable', { shallow: true });
    expect(git(install, ['tag', '--list'])).toBe('v2.4.0');
    expect(git(install, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(decide(install)).toBe('record stable');
  });

  it('records nothing once a channel is requested or saved', () => {
    const seed = officialSeed();
    expect(decide(clone(seed, 'stable'), 'beta')).toBe('none');
    expect(decide(clone(seed, 'main'), ' Edge ')).toBe('none');
    const edge = clone(seed, 'main');
    fs.writeFileSync(path.join(edge, '.env'), 'NANOCLAW_UPDATE_CHANNEL=edge\n');
    expect(decide(edge)).toBe('none');
    const saved = clone(seed, 'beta');
    fs.writeFileSync(path.join(saved, '.env'), 'OTHER=1\nNANOCLAW_UPDATE_CHANNEL="stable"\n');
    expect(decide(saved)).toBe('none');
  });

  it("warns when stable or beta is chosen on main past that channel's releases", () => {
    const install = clone(officialSeed());
    expect(decide(install, 'stable')).toBe('ahead stable');
    expect(decide(install, 'beta')).toBe('ahead beta');
    fs.writeFileSync(path.join(install, '.env'), 'NANOCLAW_UPDATE_CHANNEL=stable\n');
    expect(decide(install)).toBe('ahead stable');
    // The request overrides the saved channel.
    expect(decide(install, 'edge')).toBe('none');
  });

  it('stays quiet when main sits exactly on a release of the chosen channel', () => {
    const onRelease = clone(officialSeed({ ahead: false }));
    expect(decide(onRelease, 'stable')).toBe('none');
    expect(decide(onRelease, 'beta')).toBe('none');

    // On a release candidate: current for beta, past every release for stable.
    const seed = officialSeed();
    git(seed, ['checkout', '-q', '-B', 'main', 'v2.5.0-rc.1']);
    const onCandidate = clone(seed);
    expect(decide(onCandidate, 'beta')).toBe('none');
    expect(decide(onCandidate, 'stable')).toBe('ahead stable');
    expect(decide(onCandidate)).toBe('record-ahead stable');
  });

  it("leaves a fork alone: its branches are its owner's", () => {
    const seed = officialSeed();
    const fork = clone(seed, 'stable', { official: false });
    expect(decide(fork)).toBe('none');
    expect(decide(clone(seed, 'main', { official: false }), 'stable')).toBe('none');

    const lookalike = clone(seed, 'stable', { official: false });
    git(lookalike, ['config', 'remote.origin.url', 'https://github.com/notnanocoai/nanoclaw.git']);
    expect(decide(lookalike)).toBe('none');
  });

  it('leaves a working copy alone: another branch, a local namesake, local commits, no branch', () => {
    const seed = officialSeed();
    const feature = clone(seed);
    git(feature, ['checkout', '-q', '-b', 'feature']);
    expect(decide(feature)).toBe('none');

    // A local branch called beta, cut from main: not the published beta.
    const namesake = clone(seed);
    git(namesake, ['checkout', '-q', '-b', 'beta']);
    expect(decide(namesake)).toBe('none');

    const committed = clone(seed, 'stable');
    commit(committed, 'local customization');
    expect(decide(committed)).toBe('none');

    const detached = clone(seed);
    git(detached, ['checkout', '-q', '--detach', 'v2.4.0']);
    expect(decide(detached)).toBe('none');
  });

  it('leaves an existing install alone', () => {
    const install = clone(officialSeed());
    fs.mkdirSync(path.join(install, 'data'));
    fs.writeFileSync(path.join(install, 'data', 'upgrade-state.json'), '{}\n');
    expect(decide(install)).toBe('none');
    expect(decide(install, 'stable')).toBe('none');
  });

  it('still records after a first launch that only wrote the install id', () => {
    const install = clone(officialSeed(), 'stable');
    fs.mkdirSync(path.join(install, 'data'));
    fs.writeFileSync(path.join(install, 'data', 'install-id'), 'abc');
    expect(decide(install)).toBe('record stable');
  });

  it('does nothing outside a Git checkout', () => {
    expect(decide(temp('channel-plain-'))).toBe('none');
  });

  it('reports an unknown channel instead of guessing', () => {
    const install = clone(officialSeed());
    expect(decide(install, 'nightly')).toBe('invalid nightly');
    expect(decide(install, 'sta ble')).toBe('invalid sta ble');
  });
});

describe('saved channel', () => {
  it.each([
    ['NANOCLAW_UPDATE_CHANNEL=edge\nNANOCLAW_UPDATE_CHANNEL=\n', 'edge'],
    ['NANOCLAW_UPDATE_CHANNEL=stable\nNANOCLAW_UPDATE_CHANNEL=edge\n', 'edge'],
    ["  NANOCLAW_UPDATE_CHANNEL = 'Edge'\r\n", 'edge'],
    ['NANOCLAW_UPDATE_CHANNEL=" Edge "\n', 'edge'],
  ])('reads %j as the updater does', (env, channel) => {
    const install = clone(officialSeed());
    fs.writeFileSync(path.join(install, '.env'), env);
    expect(readChannelSetting(install)).toBe(channel);
    expect(helper('update_channel_saved', install).stdout).toBe(channel);
    expect(decide(install)).toBe('none');
  });

  it.each([
    ['NANOCLAW_UPDATE_CHANNEL="ed ge"\n', 'ed ge\n'],
    // Not empty once unquoted, so it wins over beta, then trims to nothing.
    ['NANOCLAW_UPDATE_CHANNEL=beta\nNANOCLAW_UPDATE_CHANNEL=" "\n', '\n'],
    // One pair of quotes comes off, as in the updater.
    ['NANOCLAW_UPDATE_CHANNEL="\'edge\'"\n', "'edge'\n"],
  ])('records over %j, which the updater rejects', (env, read) => {
    const install = clone(officialSeed(), 'stable');
    fs.writeFileSync(path.join(install, '.env'), env);
    expect(() => readChannelSetting(install)).toThrow('Unknown update channel');
    expect(helper('update_channel_saved', install).raw).toBe(read);
    expect(decide(install)).toBe('record stable');
  });

  it('ignores a .env without the channel', () => {
    const install = clone(officialSeed(), 'beta');
    fs.writeFileSync(path.join(install, '.env'), 'OTHER=1\n');
    expect(decide(install)).toBe('record beta');
  });

  /** The channel the updater follows from this .env as each reader sees it, or "rejected" for a value it refuses. */
  const follows = {
    updater(root: string): string {
      try {
        return readChannelSetting(root);
      } catch {
        return 'rejected';
      }
    },
    shell(root: string): string {
      const value = helper('update_channel_saved', root).stdout;
      if (value === '') return 'stable'; // nothing saved: the updater's default
      return ['stable', 'beta', 'edge'].includes(value) ? value : 'rejected';
    },
  };

  // One known difference stays out: a quoted blank, which the updater rejects (see "records over" above).
  it.each([
    ['double quotes', 'NANOCLAW_UPDATE_CHANNEL="beta"\n', 'beta'],
    ['single quotes', "NANOCLAW_UPDATE_CHANNEL='edge'\n", 'edge'],
    ['mismatched quotes', 'NANOCLAW_UPDATE_CHANNEL="beta\'\n', 'rejected'],
    ['spaces around =', 'NANOCLAW_UPDATE_CHANNEL = beta\n', 'beta'],
    ['tabs, an indent and CRLF', '\tNANOCLAW_UPDATE_CHANNEL\t=\t Edge \r\n', 'edge'],
    ['an empty value', 'NANOCLAW_UPDATE_CHANNEL=\n', 'stable'],
    ['empty quotes', 'NANOCLAW_UPDATE_CHANNEL=""\n', 'stable'],
    ['an empty value after a set one', 'NANOCLAW_UPDATE_CHANNEL=beta\nNANOCLAW_UPDATE_CHANNEL=\n', 'beta'],
    [
      'a duplicate key, where the last wins',
      'NANOCLAW_UPDATE_CHANNEL=edge\nOTHER=1\nNANOCLAW_UPDATE_CHANNEL=beta\n',
      'beta',
    ],
    ['a commented-out key', '# NANOCLAW_UPDATE_CHANNEL=edge\n', 'stable'],
    ['an indented comment after the key', 'NANOCLAW_UPDATE_CHANNEL=beta\n  # NANOCLAW_UPDATE_CHANNEL=edge\n', 'beta'],
    ['an inline comment', 'NANOCLAW_UPDATE_CHANNEL=beta # pinned\n', 'rejected'],
    ['upper case', 'NANOCLAW_UPDATE_CHANNEL=BETA\n', 'beta'],
    ['an export prefix', 'export NANOCLAW_UPDATE_CHANNEL=edge\n', 'stable'],
    ['a longer key', 'NANOCLAW_UPDATE_CHANNEL_OLD=edge\n', 'stable'],
    ['no final newline', 'OTHER=1\nNANOCLAW_UPDATE_CHANNEL=edge', 'edge'],
  ])('reads the same channel as the updater for %s', (_name, env, channel) => {
    const root = temp('channel-env-');
    fs.writeFileSync(path.join(root, '.env'), env);
    expect(follows.updater(root)).toBe(channel);
    expect(follows.shell(root)).toBe(channel);
  });
});

describe('the updater on a cloned channel branch', () => {
  const resolve = (install: string, channel: 'stable' | 'beta') =>
    resolveUpdateTarget({ projectRoot: install, remote: 'origin', channel });

  it('resolves stable and beta to the release each branch is on', () => {
    const seed = officialSeed();
    expect(resolve(clone(seed, 'stable'), 'stable')).toMatchObject({ channel: 'stable', tag: 'v2.4.0' });
    expect(resolve(clone(seed, 'beta'), 'beta')).toMatchObject({ channel: 'beta', tag: 'v2.5.0-rc.1' });
  });

  it('stops ahead of the release on main, which the note for a clone of main warns of', () => {
    expect(() => resolve(clone(officialSeed()), 'stable')).toThrow(AheadOfReleaseError);
  });
});

/** The real nanoclaw.sh on every branch of an official seed; bootstrap and the setup hand-off are stubs. */
function entrypointClone(branch: string) {
  const files: Record<string, string> = {
    'assets/setup-splash.txt': 'splash\n',
    'setup.sh': 'touch bootstrap-ran\n',
  };
  for (const file of [
    'nanoclaw.sh',
    ...['diagnostics', 'jq', 'node-version', 'sudo-preflight', 'update-channel'].map((lib) => `setup/lib/${lib}.sh`),
  ]) {
    files[file] = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  }
  const install = clone(officialSeed({ files }), branch);
  const bin = temp('channel-bin-');
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
  return { install, run, head: git(install, ['rev-parse', 'HEAD']) };
}

// Root gets nanoclaw.sh's own "running as root" prompt, which needs a terminal.
describe.skipIf(process.getuid?.() === 0)('nanoclaw.sh', { timeout: 30_000 }, () => {
  const untouched = (install: string, head: string, branch: string) => {
    expect(git(install, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(install, ['symbolic-ref', '--short', 'HEAD'])).toBe(branch);
    expect(fs.existsSync(path.join(install, '.env'))).toBe(false);
  };
  const switching =
    'Switching branches later does not change the channel. To change it: pnpm exec tsx scripts/update-nanoclaw.ts set-channel --channel <stable|beta|edge>';
  // Under the splash, which would otherwise scroll it away, and in setup.log.
  const shown = (install: string, stdout: string, note: string) => {
    expect(stdout.indexOf('splash\n')).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf(note)).toBeGreaterThan(stdout.indexOf('splash\n'));
    expect(fs.readFileSync(path.join(install, 'logs/setup.log'), 'utf8')).toContain(`  note: ${note}\n`);
  };

  it.each(['stable', 'beta'])('hands setup the %s channel for a clone of that branch', (branch) => {
    const { install, run, head } = entrypointClone(branch);
    const result = run(['--template-path', 'sales/sdr']);
    expect(result.status).toBe(0);
    shown(install, result.stdout, `This copy is the ${branch} branch, so updates follow the ${branch} channel.`);
    expect(result.stdout).toContain(switching);
    expect(result.stdout).toContain(
      `HANDOFF args=[--silent run setup:auto --template-path sales/sdr] channel=[${branch}]`,
    );
    untouched(install, head, branch);
  });

  it('hands setup stable for a clone of main, and says the first update waits', () => {
    const { install, run, head } = entrypointClone('main');
    const result = run([]);
    expect(result.status).toBe(0);
    shown(
      install,
      result.stdout,
      "This copy is main, which is newer than the stable channel's releases: its first update waits for one that includes it.",
    );
    expect(result.stdout).toContain('To follow main instead, set up with: bash nanoclaw.sh --update-channel edge');
    expect(result.stdout).toContain(switching);
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto] channel=[stable]');
    untouched(install, head, 'main');
  });

  it('follows main only when edge is asked for', () => {
    const { run } = entrypointClone('main');
    const flag = run(['--update-channel', 'edge']);
    expect(flag.status).toBe(0);
    expect(flag.stdout).not.toContain('This copy is');
    expect(flag.stdout).toContain('HANDOFF args=[--silent run setup:auto --update-channel edge] channel=[]');
    const env = run([], { NANOCLAW_UPDATE_CHANNEL: 'edge' });
    expect(env.status).toBe(0);
    expect(env.stdout).not.toContain('This copy is');
    expect(env.stdout).toContain('HANDOFF args=[--silent run setup:auto] channel=[edge]');
  });

  it('leaves a requested channel to setup, and warns when main is past its releases', () => {
    const { install, run, head } = entrypointClone('main');
    const result = run(['--update-channel', 'stable']);
    expect(result.status).toBe(0);
    shown(
      install,
      result.stdout,
      "This copy is main, which is newer than the stable channel's releases: its first update waits for one that includes it.",
    );
    expect(result.stdout).toContain('bash nanoclaw.sh --update-channel edge');
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto --update-channel stable] channel=[]');
    untouched(install, head, 'main');
  });

  it('takes the channel from the environment too, and stays quiet when it fits', () => {
    const { install, run } = entrypointClone('stable');
    const result = run([], { NANOCLAW_UPDATE_CHANNEL: 'beta' });
    expect(result.stdout).not.toContain('This copy is');
    expect(fs.readFileSync(path.join(install, 'logs/setup.log'), 'utf8')).not.toContain('update-channel');
    expect(result.stdout).toContain('HANDOFF args=[--silent run setup:auto] channel=[beta]');
  });

  it('ignores a channel after the end-of-options marker, like setup does', () => {
    const { run } = entrypointClone('stable');
    const result = run(['--', '--update-channel', 'nightly']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'HANDOFF args=[--silent run setup:auto -- --update-channel nightly] channel=[stable]',
    );
  });

  it.each([
    [['--update-channel=nightly'], 'unknown update channel "nightly"'],
    [['--update-channel'], 'Missing value for --update-channel'],
  ])('stops on %j before installing anything', (args, message) => {
    const { install, run } = entrypointClone('main');
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(message);
    expect(fs.existsSync(path.join(install, 'bootstrap-ran'))).toBe(false);
  });
});
