import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { upsertEnvVar } from '../../setup/set-env.js';
import { abandonUpdate, prepareUpdate } from './transaction.js';
import {
  AheadOfReleaseError,
  compareReleaseTags,
  parseReleaseTag,
  readChannelSetting,
  resolveUpdateTarget,
  stampChannel,
  writeChannelSetting,
} from './channel.js';

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
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(root: string, message: string): string {
  fs.writeFileSync(path.join(root, 'log.txt'), `${message}\n`, { flag: 'a' });
  git(root, ['add', '--all']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function tag(root: string, name: string, annotated = true): void {
  const args = annotated ? ['tag', '-a', name, '-m', name] : ['tag', name];
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args]);
}

/**
 * Official repo history: v2.3.0 -> v2.4.0 -> v2.5.0-rc.1 -> main tip, plus
 * the junk tags the real remote carries. The install sits at `installAt`.
 */
function fixture(installAt: string) {
  const seed = temp('channel-seed-');
  git(seed, ['init', '-q', '-b', 'main']);
  const shas: Record<string, string> = {};
  shas['v2.3.0'] = commit(seed, 'v2.3.0');
  tag(seed, 'v2.3.0');
  shas['v2.4.0'] = commit(seed, 'v2.4.0');
  tag(seed, 'v2.4.0');
  tag(seed, 'pre-update-852435f4-20260827104121-ad21ae1c');
  shas['v2.5.0-rc.1'] = commit(seed, 'rc');
  tag(seed, 'v2.5.0-rc.1');
  tag(seed, 'v9.9.9', false); // lightweight: never a release
  tag(seed, 'pre-squash/opencode');
  shas.main = commit(seed, 'main tip');
  tag(seed, 'v99.0.0-junk');

  const official = path.join(temp('channel-official-'), 'official.git');
  git(path.dirname(official), ['clone', '-q', '--bare', seed, official]);
  const install = path.join(temp('channel-install-'), 'install');
  git(path.dirname(install), ['clone', '-q', '--no-tags', official, install]);
  git(install, ['remote', 'rename', 'origin', 'upstream']);
  git(install, ['checkout', '-q', '-B', 'main', shas[installAt]]);
  return { seed, official, install, shas };
}

describe('release tag parsing', () => {
  it('accepts only vX.Y.Z and vX.Y.Z-rc.N', () => {
    expect(parseReleaseTag('v2.4.0')).toMatchObject({ major: 2, minor: 4, patch: 0 });
    expect(parseReleaseTag('v2.5.0-rc.3')).toMatchObject({ rc: 3 });
    for (const junk of [
      'pre-update-852435f4-20260827',
      'pre-squash/x',
      'voice-recipe-snapshot',
      'v2.4',
      '2.4.0',
      'v2.4.0-beta',
    ]) {
      expect(parseReleaseTag(junk)).toBeNull();
    }
  });

  it('sorts CalVer after 2.x and a release after its release candidates', () => {
    const sorted = ['v2026.10.0', 'v2.4.0', 'v2.10.0', 'v2026.10.0-rc.2', 'v2026.9.1', 'v2026.10.0-rc.10'].sort(
      compareReleaseTags,
    );
    expect(sorted).toEqual(['v2.4.0', 'v2.10.0', 'v2026.9.1', 'v2026.10.0-rc.2', 'v2026.10.0-rc.10', 'v2026.10.0']);
  });
});

describe('channel setting', () => {
  it('defaults to stable, reads .env, and lets --channel override it', () => {
    const root = temp('channel-env-');
    expect(readChannelSetting(root)).toBe('stable');
    fs.writeFileSync(path.join(root, '.env'), 'OTHER=1\nNANOCLAW_UPDATE_CHANNEL="edge"\n');
    expect(readChannelSetting(root)).toBe('edge');
    expect(readChannelSetting(root, 'stable')).toBe('stable');
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_UPDATE_CHANNEL = edge\nNANOCLAW_UPDATE_CHANNEL=\n');
    expect(readChannelSetting(root)).toBe('edge');
    expect(() => readChannelSetting(root, 'nightly')).toThrow(/stable, beta, edge/);
  });
});

describe('writeChannelSetting', () => {
  const env = (root: string) => fs.readFileSync(path.join(root, '.env'), 'utf8');

  it('adds the key to a missing or existing .env and keeps other lines and comments', () => {
    const root = temp('channel-write-');
    writeChannelSetting(root, 'edge', upsertEnvVar);
    expect(env(root)).toBe('NANOCLAW_UPDATE_CHANNEL=edge\n');
    fs.writeFileSync(path.join(root, '.env'), '# keep me\nOTHER=1\n');
    writeChannelSetting(root, 'stable', upsertEnvVar);
    expect(env(root)).toBe('# keep me\nOTHER=1\nNANOCLAW_UPDATE_CHANNEL=stable\n');
  });

  it('replaces an existing value in place, is idempotent, and is read back', () => {
    const root = temp('channel-write-');
    fs.writeFileSync(path.join(root, '.env'), 'A=1\nNANOCLAW_UPDATE_CHANNEL="stable"\n# note\nB=2\n');
    writeChannelSetting(root, 'edge', upsertEnvVar);
    const once = env(root);
    expect(once).toBe('A=1\nNANOCLAW_UPDATE_CHANNEL=edge\n# note\nB=2\n');
    writeChannelSetting(root, 'edge', upsertEnvVar);
    expect(env(root)).toBe(once);
    expect(readChannelSetting(root)).toBe('edge');
  });

  it('fails when the writer did not save to this install (pre-2.4 writers use the cwd)', () => {
    const root = temp('channel-write-');
    expect(() => writeChannelSetting(root, 'edge', () => undefined)).toThrow(/Could not save/);
  });

  it('rejects an unknown channel without touching .env', () => {
    const root = temp('channel-write-');
    fs.writeFileSync(path.join(root, '.env'), 'A=1\n');
    expect(() => writeChannelSetting(root, 'nightly', upsertEnvVar)).toThrow(/stable, beta, edge/);
    expect(env(root)).toBe('A=1\n');
  });
});

describe('resolveUpdateTarget', () => {
  const resolve = (install: string, channel: 'stable' | 'beta' | 'edge') =>
    resolveUpdateTarget({ projectRoot: install, remote: 'upstream', channel });

  it('stable resolves to the newest annotated vX.Y.Z tag and ignores junk, lightweight and rc tags', () => {
    const { install, shas } = fixture('v2.3.0');
    expect(resolve(install, 'stable')).toEqual({ channel: 'stable', ref: 'refs/tags/v2.4.0', tag: 'v2.4.0' });
    expect(git(install, ['rev-parse', 'refs/tags/v2.4.0^{commit}'])).toBe(shas['v2.4.0']);
  });

  it('beta resolves to the newest release candidate newer than stable', () => {
    const { install } = fixture('v2.3.0');
    expect(resolve(install, 'beta')).toMatchObject({ channel: 'beta', ref: 'refs/tags/v2.5.0-rc.1' });
  });

  it('edge resolves to the remote main branch', () => {
    const { install } = fixture('main');
    expect(resolve(install, 'edge')).toEqual({ channel: 'edge', ref: 'upstream/main' });
  });

  it('allows stable for a customized install whose upstream base is behind the tag', () => {
    const { install } = fixture('v2.3.0');
    commit(install, 'local customization');
    expect(resolve(install, 'stable').tag).toBe('v2.4.0');
  });

  it('refuses to move an install past the latest release backward to it', () => {
    const { install } = fixture('main');
    commit(install, 'local customization');
    expect(() => resolve(install, 'stable')).toThrow(/newer than v2\.4\.0[\s\S]*NANOCLAW_UPDATE_CHANNEL=edge/);
    try {
      resolve(install, 'stable');
    } catch (err) {
      expect(err).toBeInstanceOf(AheadOfReleaseError);
      expect(err).toMatchObject({ code: 'ahead-of-release', tag: 'v2.4.0', channel: 'stable' });
    }
  });

  it('fetches the remote main itself, so a stale tracking ref cannot hide newer upstream commits', () => {
    const { install, shas } = fixture('main');
    git(install, ['update-ref', 'refs/remotes/upstream/main', shas['v2.3.0']]);
    expect(() => resolve(install, 'stable')).toThrow(/newer than v2\.4\.0/);
    expect(git(install, ['rev-parse', 'upstream/main'])).toBe(shas.main);
  });

  it('picks CalVer over 2.x', () => {
    const { seed, official, install } = fixture('v2.3.0');
    tag(seed, 'v2026.10.0');
    git(seed, ['push', '-q', official, 'refs/tags/v2026.10.0']);
    expect(resolve(install, 'stable').tag).toBe('v2026.10.0');
  });
});

describe('prepare on a release tag', () => {
  it('stages the newer stable tag and records the channel', () => {
    const { install, shas } = fixture('v2.3.0');
    // prepareUpdate's runner inherits process.env; keep the operator's git config (e.g. merge.ff) out.
    const saved = { ...process.env };
    Object.assign(process.env, {
      NANOCLAW_UPDATE_DIR: temp('channel-updates-'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    try {
      const target = resolveUpdateTarget({ projectRoot: install, remote: 'upstream', channel: 'stable' });
      const state = prepareUpdate({ projectRoot: install, upstreamRef: target.ref, channel: target.channel });
      expect(state).toMatchObject({ phase: 'prepared', channel: 'stable', upstreamRef: 'refs/tags/v2.4.0' });
      expect(state.targetHead).toBe(shas['v2.4.0']);
      expect(git(install, ['rev-parse', 'HEAD'])).toBe(shas['v2.3.0']);
      abandonUpdate(install, state.id);
    } finally {
      for (const key of ['NANOCLAW_UPDATE_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe('stampChannel', () => {
  it('adds the channel and ref to the marker the target code wrote', () => {
    const root = temp('channel-stamp-');
    fs.mkdirSync(path.join(root, 'data'));
    const marker = path.join(root, 'data/upgrade-state.json');
    fs.writeFileSync(marker, JSON.stringify({ version: '2.4.0', commit: 'abc', tree: 'def', via: 'update-nanoclaw' }));
    stampChannel(root, { channel: 'stable', ref: 'refs/tags/v2.4.0' });
    expect(JSON.parse(fs.readFileSync(marker, 'utf8'))).toMatchObject({
      version: '2.4.0',
      commit: 'abc',
      channel: 'stable',
      ref: 'refs/tags/v2.4.0',
    });
  });
});
