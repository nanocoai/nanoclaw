/**
 * The agent-image pin has two shapes, and picking the wrong reference for the
 * running machine is not a visible failure — it is an image that pulls, retags
 * onto the local tag, and then either emulates or dies at spawn inside a `--rm`
 * container whose logs are discarded.
 *
 * The `container/pull.sh` half of this resolution is shell and is covered by
 * the sibling assertions at the bottom: the two readers must stay in step,
 * because --status compares against whatever pull.sh actually used.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { pinnedPlatforms, resolvePinForPlatform } from './registry-state.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const PER_ARCH = {
  'linux/amd64': 'reg.example.com/nanoclaw/agent@sha256:aaaa',
  'linux/arm64': 'reg.example.com/nanoclaw/agent@sha256:bbbb',
};

describe('resolvePinForPlatform', () => {
  it('returns a single reference unchanged for every platform', () => {
    // A multi-arch index is docker's job to resolve. Second-guessing it here is
    // how you end up pulling the wrong child.
    const ref = 'reg.example.com/nanoclaw/agent@sha256:cccc';
    expect(resolvePinForPlatform(ref, 'linux/amd64')).toBe(ref);
    expect(resolvePinForPlatform(ref, 'linux/arm64')).toBe(ref);
  });

  it('selects the matching entry from a per-platform pin', () => {
    expect(resolvePinForPlatform(PER_ARCH, 'linux/amd64')).toBe(PER_ARCH['linux/amd64']);
    expect(resolvePinForPlatform(PER_ARCH, 'linux/arm64')).toBe(PER_ARCH['linux/arm64']);
  });

  it('returns undefined rather than any reference when the platform is absent', () => {
    // Falling back to "some other architecture's image" would be worse than
    // failing: it pulls and retags before anything notices.
    expect(resolvePinForPlatform(PER_ARCH, 'linux/riscv64')).toBeUndefined();
  });

  it('ignores shapes that are not a reference', () => {
    expect(resolvePinForPlatform(undefined, 'linux/arm64')).toBeUndefined();
    expect(resolvePinForPlatform(null, 'linux/arm64')).toBeUndefined();
    expect(resolvePinForPlatform('', 'linux/arm64')).toBeUndefined();
    expect(resolvePinForPlatform('   ', 'linux/arm64')).toBeUndefined();
    expect(resolvePinForPlatform([PER_ARCH], 'linux/arm64')).toBeUndefined();
    expect(resolvePinForPlatform({ 'linux/arm64': 42 }, 'linux/arm64')).toBeUndefined();
  });

  it('trims, so a stray newline in a hand-edited pin still resolves', () => {
    expect(resolvePinForPlatform({ 'linux/arm64': ' repo@sha256:dddd\n' }, 'linux/arm64')).toBe(
      'repo@sha256:dddd',
    );
  });
});

describe('pinnedPlatforms', () => {
  it('lists the platforms an object pin declares', () => {
    expect(pinnedPlatforms(PER_ARCH)).toEqual(['linux/amd64', 'linux/arm64']);
  });

  it('is empty for a single reference, which declares no platforms', () => {
    expect(pinnedPlatforms('repo@sha256:cccc')).toEqual([]);
    expect(pinnedPlatforms(undefined)).toEqual([]);
  });

  it('omits entries that are not usable references', () => {
    expect(pinnedPlatforms({ 'linux/amd64': 'repo@sha256:aaaa', 'linux/arm64': '' })).toEqual([
      'linux/amd64',
    ]);
  });
});

describe('the shell reader stays in step', () => {
  const pullSh = fs.readFileSync(path.join(here, '..', '..', 'container', 'pull.sh'), 'utf-8');

  it('resolves the daemon architecture, not the host CPU', () => {
    // Docker Desktop, a remote daemon and a cross-architecture context all make
    // these differ, and the daemon is what executes the image.
    expect(pullSh).toContain("version --format '{{.Server.Arch}}'");
  });

  it('reads a per-platform pin as well as a single reference', () => {
    expect(pullSh).toContain('read_version_pin_platform');
    expect(pullSh).toContain('version_pin_platforms');
  });

  it('keys per-platform lookups on linux/<arch>, as this module does', () => {
    expect(pullSh).toContain('HOST_PLATFORM="linux/${HOST_ARCH}"');
  });
});
