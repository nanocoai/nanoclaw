import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assembleReleaseBody,
  changelogSection,
  compareTags,
  isPrerelease,
  publicationPlan,
  publicationReadbackStatus,
  tagsFromLsRemote,
  unreleasedSection,
  verifyRelease,
  verifyReleaseOrder,
} from './release.mjs';
import { compareReleaseTags } from './update/channel.js';

const releaseWorkflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const repositoryChangelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

const changelog = `# Changelog

## [Unreleased]

## [2.1.54] - 2026-07-31

Rollup release.

- First curated change.
- Second curated change.

## [2.1.17] - 2026-06-17

- Previous change.
`;

describe('release metadata', () => {
  it('extracts exactly one dated version section', () => {
    expect(changelogSection(changelog, '2.1.54')).toBe(
      'Rollup release.\n\n- First curated change.\n- Second curated change.',
    );
  });

  it('carries the categorized 2.4-style entry through whole: lead paragraph, headings and every bullet', () => {
    const categorized = `# Changelog

## [Unreleased]

## [2.4.0] - 2026-09-23

NanoClaw 2.4.0 adds things.

### ⚠️ Before you update

- [BREAKING] **Forks must act.** Run \`/add-onecli\`.

### ✨ New

- **A feature.** Detail.

## [2.3.0] - 2026-08-20

- Previous change.
`;
    const section = verifyRelease({ changelog: categorized, packageVersion: '2.4.0', version: '2.4.0' });
    expect(section.startsWith('NanoClaw 2.4.0 adds things.')).toBe(true);
    expect(section).toContain('### ⚠️ Before you update');
    expect(section).toContain('- [BREAKING] **Forks must act.** Run `/add-onecli`.');
    expect(section.endsWith('- **A feature.** Detail.')).toBe(true);
    expect(section).not.toContain('2.3.0');
  });

  it('requires the package version to match', () => {
    expect(() => verifyRelease({ changelog, packageVersion: '2.1.53', version: '2.1.54' })).toThrow('does not match');
  });

  it('keeps recovered operator-facing configuration and Photon migration in the v2.1.54 record', () => {
    const notes = changelogSection(repositoryChangelog, '2.1.54');

    expect(notes).toContain('DEFAULT_AGENT_PROVIDER');
    expect(notes).toContain('CONTAINER_CPU_LIMIT');
    expect(notes).toContain('CONTAINER_MEMORY_LIMIT');
    expect(notes).toContain('IMESSAGE_BACKEND=local|hosted');
  });

  it('rejects missing, duplicate, empty, and prefixed versions', () => {
    expect(() => changelogSection(changelog, 'v2.1.54')).toThrow('without a v prefix');
    expect(() => changelogSection(changelog, '2.1.55')).toThrow('found 0');
    expect(() => changelogSection(`${changelog}\n## [2.1.54] - 2026-08-01\n\n- Duplicate.`, '2.1.54')).toThrow(
      'found 2',
    );
    expect(() =>
      changelogSection(changelog.replace('- First curated change.\n- Second curated change.', 'No bullets.'), '2.1.54'),
    ).toThrow('at least one release-note bullet');
  });
});

describe('pre-release metadata', () => {
  const withUnreleased = changelog.replace(
    '## [Unreleased]\n',
    '## [Unreleased]\n\nNext release in progress.\n\n- Pending change.\n',
  );

  it('treats only x.y.z-beta.N and x.y.z-rc.N as pre-releases', () => {
    expect(isPrerelease('2.5.0-beta.1')).toBe(true);
    expect(isPrerelease('2.5.0-beta.12')).toBe(true);
    expect(isPrerelease('2.5.0-rc.1')).toBe(true);
    expect(isPrerelease('2.5.0-rc.12')).toBe(true);
    expect(isPrerelease('2.5.0')).toBe(false);
  });

  it.each([
    '2.5.0-rc.0',
    '2.5.0-rc.01',
    '2.5.0-rc',
    'v2.5.0-rc.1',
    '2.5.0-rc.1+build',
    '2.5.0-beta.0',
    '2.5.0-beta.01',
    '2.5.0-beta',
    'v2.5.0-beta.1',
    '2.5.0-Beta.1',
    '2.5.0-beta.1.rc.1',
    '2.5.0-alpha.1',
    '2.5.0-dev.1',
    '2.5',
  ])('rejects the unsupported version %s', (version) => {
    expect(() => isPrerelease(version)).toThrow('x.y.z, x.y.z-beta.N or x.y.z-rc.N');
  });

  it('publishes the Unreleased notes without needing a dated section', () => {
    expect(verifyRelease({ changelog: withUnreleased, packageVersion: '2.2.0-rc.1', version: '2.2.0-rc.1' })).toBe(
      'Next release in progress.\n\n- Pending change.',
    );
    expect(changelogSection(withUnreleased, '2.2.0-rc.1')).not.toContain('2.1.54');
    expect(verifyRelease({ changelog: withUnreleased, packageVersion: '2.2.0-beta.1', version: '2.2.0-beta.1' })).toBe(
      'Next release in progress.\n\n- Pending change.',
    );
  });

  it('requires the package version, Unreleased bullets, and an unreleased base version', () => {
    expect(() => verifyRelease({ changelog: withUnreleased, packageVersion: '2.2.0', version: '2.2.0-rc.1' })).toThrow(
      'does not match',
    );
    expect(() => verifyRelease({ changelog, packageVersion: '2.2.0-rc.1', version: '2.2.0-rc.1' })).toThrow(
      '[Unreleased] must contain at least one release-note bullet',
    );
    expect(() =>
      verifyRelease({ changelog: withUnreleased, packageVersion: '2.1.54-rc.1', version: '2.1.54-rc.1' }),
    ).toThrow('already records as released');
    expect(() =>
      verifyRelease({ changelog: withUnreleased, packageVersion: '2.1.54-beta.1', version: '2.1.54-beta.1' }),
    ).toThrow('already records as released');
  });

  it('requires exactly one Unreleased heading and reads it when it is the last section', () => {
    expect(() => unreleasedSection('# Changelog\n\n## [2.1.54] - 2026-07-31\n\n- Old.\n')).toThrow('found 0');
    expect(() => unreleasedSection(`${withUnreleased}\n## [Unreleased]\n\n- Again.\n`)).toThrow('found 2');
    expect(unreleasedSection('# Changelog\n\n## [Unreleased]\n\n- Only change.\n')).toBe('- Only change.');
  });

  it('assembles a pre-release body from the Unreleased notes', () => {
    const generatedNotes = `## What's Changed
* Fix one by @alice in https://github.com/nanocoai/nanoclaw/pull/1

**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/v2.1.54...v2.2.0-rc.1`;

    const body = assembleReleaseBody({ changelog: withUnreleased, generatedNotes, version: '2.2.0-rc.1' });
    expect(body.startsWith('Next release in progress.')).toBe(true);
    expect(body).not.toContain('First curated change.');
  });
});

describe('release workflow safeguards', () => {
  it('fails wrong-repository and wrong-ref dispatches instead of skipping verification', () => {
    expect(releaseWorkflow).toContain('name: Verify dispatch source');
    expect(releaseWorkflow).toContain('if [ "$DISPATCH_REPOSITORY" != "nanocoai/nanoclaw" ]');
    expect(releaseWorkflow).toContain('if [ "$DISPATCH_REF" != "refs/heads/main" ]');
    expect(releaseWorkflow).toContain('verify:\n    needs: dispatch');
    expect(releaseWorkflow).not.toContain(
      "if: github.repository == 'nanocoai/nanoclaw' && github.ref == 'refs/heads/main'",
    );
  });

  it('checks the environment in both modes and keeps the exact reviewer authorization boundary', () => {
    expect(releaseWorkflow).toContain('- name: Verify protected release environment\n        env:');
    expect(releaseWorkflow).not.toContain(
      "- name: Verify protected release environment\n        if: inputs.mode == 'publish'",
    );
    expect(releaseWorkflow).toContain(
      'EXPECTED_REVIEWERS=\'["amit-shafnir","gavrielc","glifocat","omri-maya","zvi-fried"]\'',
    );
    expect(releaseWorkflow).toContain('Release reviewer roster drift');
  });

  it('publishes pre-releases through their own environment, never as latest', () => {
    expect(releaseWorkflow).toContain("environment: ${{ contains(inputs.version, '-') && 'prerelease' || 'release' }}");
    expect(releaseWorkflow).toContain(
      'case "$RELEASE_VERSION" in *-*) ENVIRONMENT=prerelease ;; *) ENVIRONMENT=release ;; esac',
    );
    expect(releaseWorkflow).not.toContain('release.mjs environment');
    expect(releaseWorkflow).toContain('EXPECTED_REVIEWERS=\'["glifocat"]\'\n              PREVENT_SELF_REVIEW=false');
    expect(releaseWorkflow).toContain(
      'EXPECTED_REVIEWERS=\'["amit-shafnir","gavrielc","glifocat","omri-maya","zvi-fried"]\'\n              PREVENT_SELF_REVIEW=true',
    );
    expect(releaseWorkflow).toContain('environments/${ENVIRONMENT}/deployment-branch-policies');
    expect(releaseWorkflow).toContain(
      [
        '          if [[ "$RELEASE_VERSION" == *-* ]]; then',
        '            CHANNEL_FLAGS=(--prerelease --latest=false)',
        '          else',
        '            CHANNEL_FLAGS=(--latest)',
        '          fi',
      ].join('\n'),
    );
    expect(releaseWorkflow).toContain('--verify-tag \\\n              "${CHANNEL_FLAGS[@]}"');
    expect(releaseWorkflow.match(/--latest|--prerelease/g)).toEqual(['--prerelease', '--latest', '--latest']);
  });

  it('measures release notes from the previous stable tag, skipping pre-releases', () => {
    expect(releaseWorkflow).toContain(
      `PREVIOUS_TAG=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*-*' "$TARGET_SHA^")`,
    );
    expect(releaseWorkflow).not.toContain('git describe --tags --abbrev=0 "$TARGET_SHA^"');
  });

  it('bounds post-publication API propagation retries and fails closed after the deadline', () => {
    expect(releaseWorkflow).toContain('READBACK_ATTEMPTS=6');
    expect(releaseWorkflow).toContain('READBACK_DELAY_SECONDS=2');
    expect(releaseWorkflow).toContain('node scripts/release.mjs readback');
    expect(releaseWorkflow).toContain('sleep "$READBACK_DELAY_SECONDS"');
    expect(releaseWorkflow).toContain('Timed out waiting for GitHub to return the exact immutable release');
    expect(releaseWorkflow).not.toContain('test "$FINAL_STATE" = "already-published"');
  });
});

describe('release body assembly', () => {
  it('keeps curated notes and appends first-time and complete contributor sections', () => {
    const generatedNotes = `## What's Changed
* Fix one by @alice in https://github.com/nanocoai/nanoclaw/pull/1
* Fix two by @bob in https://github.com/nanocoai/nanoclaw/pull/2

## New Contributors
* @alice made their first contribution in https://github.com/nanocoai/nanoclaw/pull/1

**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/v2.1.17...v2.1.54`;

    const body = assembleReleaseBody({ changelog, generatedNotes, version: '2.1.54' });

    expect(body).toContain('Rollup release.');
    expect(body).toContain('## New Contributors\n\n* @alice');
    expect(body).toContain('## Contributors\n\nThanks to everyone');
    expect(body).toContain('Fix one by @alice');
    expect(body).toContain('Fix two by @bob');
    expect(body).toContain('compare/v2.1.17...v2.1.54');
    expect(body.indexOf('Rollup release.')).toBeLessThan(body.indexOf('## Contributors'));
  });

  it('works when GitHub reports no first-time contributors', () => {
    const generatedNotes = `## What's Changed
* Fix one by @alice in https://github.com/nanocoai/nanoclaw/pull/1

**Full Changelog**: https://github.com/nanocoai/nanoclaw/compare/v2.1.17...v2.1.54`;

    const body = assembleReleaseBody({ changelog, generatedNotes, version: '2.1.54' });

    expect(body).not.toContain('## New Contributors');
    expect(body).toContain('## Contributors');
  });
});

describe('publication recovery', () => {
  const targetSha = 'a'.repeat(40);
  const expectedBody = 'Curated notes.\n';
  const annotatedTag = { exists: true, type: 'tag', sha: targetSha };
  const matchingRelease = {
    body: expectedBody,
    draft: false,
    html_url: 'https://github.com/nanocoai/nanoclaw/releases/tag/v2.1.54',
    immutable: true,
    name: 'v2.1.54',
    prerelease: false,
    tag_name: 'v2.1.54',
  };

  function plan(overrides: Record<string, unknown> = {}) {
    return publicationPlan({
      expectedBody,
      release: null,
      tagState: { exists: false },
      targetSha,
      version: '2.1.54',
      ...overrides,
    });
  }

  function readback(overrides: Record<string, unknown> = {}) {
    return publicationReadbackStatus({
      expectedBody,
      release: matchingRelease,
      tagState: annotatedTag,
      targetSha,
      version: '2.1.54',
      ...overrides,
    });
  }

  it('creates both objects when neither exists', () => {
    expect(plan()).toBe('create-tag-and-release');
  });

  it('resumes release creation after an exact annotated tag was pushed', () => {
    expect(plan({ tagState: annotatedTag })).toBe('create-release');
  });

  it('treats an exact published release as an idempotent success', () => {
    expect(plan({ release: matchingRelease, tagState: annotatedTag })).toBe('already-published');
  });

  it('expects a pre-release to be published as a prerelease, and only a pre-release', () => {
    const rcRelease = { ...matchingRelease, name: 'v2.2.0-rc.1', tag_name: 'v2.2.0-rc.1', prerelease: true };
    const rc = { release: rcRelease, tagState: annotatedTag, version: '2.2.0-rc.1' };
    expect(plan(rc)).toBe('already-published');
    expect(() => plan({ ...rc, release: { ...rcRelease, prerelease: false } })).toThrow(
      'is not marked as a prerelease',
    );
    expect(plan({ version: '2.2.0-rc.1' })).toBe('create-tag-and-release');
    const betaRelease = { ...rcRelease, name: 'v2.2.0-beta.1', tag_name: 'v2.2.0-beta.1' };
    expect(plan({ release: betaRelease, tagState: annotatedTag, version: '2.2.0-beta.1' })).toBe('already-published');
    expect(() =>
      plan({ release: { ...betaRelease, prerelease: false }, tagState: annotatedTag, version: '2.2.0-beta.1' }),
    ).toThrow('is not marked as a prerelease');
  });

  it('retries only exact release states that are still propagating', () => {
    expect(readback()).toBe('already-published');
    expect(readback({ release: null })).toBe('pending');
    expect(readback({ release: { ...matchingRelease, immutable: false } })).toBe('pending');
    expect(readback({ release: { ...matchingRelease, immutable: undefined } })).toBe('pending');
  });

  it.each([
    ['missing tag and release', { release: null, tagState: { exists: false } }, 'unsafe plan'],
    ['wrong title', { release: { ...matchingRelease, name: 'Wrong' } }, 'title'],
    ['changed body', { release: { ...matchingRelease, body: 'Different' } }, 'body'],
    ['wrong tag target', { tagState: { ...annotatedTag, sha: 'b'.repeat(40) } }, 'not workflow target'],
  ])('fails post-publication read-back immediately for %s', (_name, overrides, message) => {
    expect(() => readback(overrides)).toThrow(message);
  });

  it.each([
    ['lightweight tag', { tagState: { ...annotatedTag, type: 'commit' } }, 'not an annotated tag'],
    ['wrong tag target', { tagState: { ...annotatedTag, sha: 'b'.repeat(40) } }, 'not workflow target'],
    ['missing tag', { release: matchingRelease }, 'tag was not fetched'],
    ['wrong release tag', { release: { ...matchingRelease, tag_name: 'v2.1.53' }, tagState: annotatedTag }, 'tag'],
    ['wrong release title', { release: { ...matchingRelease, name: 'Wrong' }, tagState: annotatedTag }, 'title'],
    ['draft release', { release: { ...matchingRelease, draft: true }, tagState: annotatedTag }, 'still a draft'],
    [
      'prerelease',
      { release: { ...matchingRelease, prerelease: true }, tagState: annotatedTag },
      'marked as a prerelease',
    ],
    ['mutable release', { release: { ...matchingRelease, immutable: false }, tagState: annotatedTag }, 'not immutable'],
    [
      'release without immutable state',
      { release: { ...matchingRelease, immutable: undefined }, tagState: annotatedTag },
      'not immutable',
    ],
    ['changed body', { release: { ...matchingRelease, body: 'Different' }, tagState: annotatedTag }, 'body'],
  ])('rejects a mismatched %s', (_name, overrides, message) => {
    expect(() => plan(overrides)).toThrow(message);
  });
});

describe('release.mjs verify command', () => {
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function verify(version: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-verify-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
    writeFileSync(
      path.join(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n- Pending change.\n\n## [2026.10.1] - 2026-10-23\n\n- Old.\n',
    );
    return execFileSync(process.execPath, [script, 'verify', version], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  }

  it('accepts a beta and an rc of the next version', () => {
    expect(verify('2026.11.0-beta.1')).toBe('release metadata verified for v2026.11.0-beta.1\n');
    expect(verify('2026.11.0-rc.1')).toBe('release metadata verified for v2026.11.0-rc.1\n');
  });

  it.each(['2026.11.0-alpha.1', '2026.11.0-beta', '2026.11.0-beta.0', '2026.11.0-preview.1'])(
    'rejects %s',
    (version) => {
      expect(() => verify(version)).toThrow(/version must be x\.y\.z, x\.y\.z-beta\.N or x\.y\.z-rc\.N/);
    },
  );
});

describe('release order check', () => {
  const existing = ['v2026.10.0', 'v2026.10.1-rc.1', 'v2026.10.1-rc.2', 'pre-update-x', 'v99.0.0-junk'];

  it('refuses a beta once an rc of the same version exists', () => {
    expect(() => verifyReleaseOrder('2026.11.0-beta.2', [...existing, 'v2026.11.0-rc.1'])).toThrow(
      'v2026.11.0-beta.2 does not sort above v2026.11.0-rc.1, which already exists',
    );
  });

  it('refuses a lower number after a higher one', () => {
    expect(() => verifyReleaseOrder('2026.11.0-beta.2', [...existing, 'v2026.11.0-beta.3'])).toThrow(
      'does not sort above v2026.11.0-beta.3',
    );
    expect(() => verifyReleaseOrder('2026.11.0-rc.1', [...existing, 'v2026.11.0-rc.2'])).toThrow(
      'does not sort above v2026.11.0-rc.2',
    );
  });

  it('refuses any pre-release once the release exists', () => {
    for (const version of ['2026.11.0-beta.9', '2026.11.0-rc.3']) {
      expect(() => verifyReleaseOrder(version, [...existing, 'v2026.11.0-rc.2', 'v2026.11.0'])).toThrow(
        'does not sort above v2026.11.0,',
      );
    }
  });

  it('refuses a tie with a differently spelled tag', () => {
    expect(() => verifyReleaseOrder('2026.11.0-rc.1', [...existing, 'v2026.11.0-rc.01'])).toThrow(
      'does not sort above v2026.11.0-rc.01',
    );
  });

  it('passes the normal next beta, rc and release', () => {
    const tags = [...existing, 'v2026.11.0-beta.1', 'v2026.11.0-beta.2'];
    expect(() => verifyReleaseOrder('2026.11.0-beta.3', tags)).not.toThrow();
    expect(() => verifyReleaseOrder('2026.11.0-rc.1', tags)).not.toThrow();
    expect(() => verifyReleaseOrder('2026.11.0-rc.2', [...tags, 'v2026.11.0-rc.1'])).not.toThrow();
    expect(() => verifyReleaseOrder('2026.11.0', [...tags, 'v2026.11.0-rc.1'])).not.toThrow();
  });

  it('passes a version with no tags yet, ignoring other versions and junk', () => {
    expect(() => verifyReleaseOrder('2026.11.0-beta.1', existing)).not.toThrow();
    expect(() => verifyReleaseOrder('2026.11.0-rc.1', [...existing, 'v2026.12.0-beta.4'])).not.toThrow();
  });

  it('passes a publish rerun whose own tag was already pushed', () => {
    expect(() => verifyReleaseOrder('2026.11.0-beta.1', [...existing, 'v2026.11.0-beta.1'])).not.toThrow();
    expect(() => verifyReleaseOrder('2026.11.0', [...existing, 'v2026.11.0-rc.1', 'v2026.11.0'])).not.toThrow();
  });

  it('still rejects an unsupported version', () => {
    expect(() => verifyReleaseOrder('2026.11.0-alpha.1', existing)).toThrow('x.y.z, x.y.z-beta.N or x.y.z-rc.N');
  });

  it('orders tags exactly as the update channel does', () => {
    const tags = [
      'v2.4.0',
      'v2.10.0',
      'v2026.10.0',
      'v2026.10.1-rc.1',
      'v2026.10.1-rc.01',
      'v2026.10.1-rc.10',
      'v2026.10.1',
      'v2026.11.0-beta.1',
      'v2026.11.0-beta.2',
      'v2026.11.0-beta.10',
      'v2026.11.0-rc.1',
      'v2026.11.0',
    ];
    for (const a of tags) {
      for (const b of tags) {
        expect([a, b, Math.sign(compareTags(a, b))]).toEqual([a, b, Math.sign(compareReleaseTags(a, b))]);
      }
    }
  });

  it('reads tag names from git ls-remote output and refuses an empty list', () => {
    const listing = [
      'aaa\trefs/tags/v2026.11.0-beta.1',
      'bbb\trefs/tags/v2026.11.0-beta.1^{}',
      'ccc\trefs/tags/v2026.10.1',
      '',
    ].join('\n');
    expect(tagsFromLsRemote(listing)).toEqual(['v2026.11.0-beta.1', 'v2026.10.1']);
    expect(() => tagsFromLsRemote('')).toThrow('the tag list is empty');
    expect(() => tagsFromLsRemote('warning: something\n')).toThrow('the tag list is empty');
  });
});

describe('release.mjs order command', () => {
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // An empty directory: the command must not need package.json or CHANGELOG.md.
  function order(version: string, listing?: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-order-cli-'));
    dirs.push(dir);
    const args = [script, 'order', version];
    if (listing !== undefined) {
      writeFileSync(path.join(dir, 'tags.txt'), listing);
      args.push('tags.txt');
    }
    return execFileSync(process.execPath, args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  }

  it('passes the next pre-release and refuses one below an existing tag', () => {
    const listing = 'aaa\trefs/tags/v2026.10.1\nbbb\trefs/tags/v2026.11.0-rc.1\n';
    expect(order('2026.11.0-rc.2', listing)).toBe('v2026.11.0-rc.2 sorts above every existing tag of its version\n');
    expect(() => order('2026.11.0-beta.2', listing)).toThrow('does not sort above v2026.11.0-rc.1');
  });

  it('runs main() when started through a symlinked path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-order-link-'));
    dirs.push(dir);
    symlinkSync(script, path.join(dir, 'release.mjs'));
    writeFileSync(path.join(dir, 'tags.txt'), 'aaa\trefs/tags/v2026.11.0-rc.1\n');
    expect(() =>
      execFileSync(process.execPath, [path.join(dir, 'release.mjs'), 'order', '2026.11.0-beta.1', 'tags.txt'], {
        cwd: dir,
        stdio: 'pipe',
      }),
    ).toThrow('does not sort above v2026.11.0-rc.1');
  });

  it('fails without a tag list', () => {
    expect(() => order('2026.11.0-beta.1')).toThrow('order requires the path to a git ls-remote tag list');
    expect(() => order('2026.11.0-beta.1', '')).toThrow('the tag list is empty');
  });
});

describe('release workflow order check', () => {
  const script = fileURLToPath(new URL('./release.mjs', import.meta.url));
  const lines = releaseWorkflow.split('\n');
  const start = lines.findIndex((line) => line.includes("# Order check from this workflow's own commit"));
  const block = lines
    .slice(start, start + 6)
    .map((line) => line.trim())
    .join('\n');
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: 'pipe' },
    ).trim();

  /** The target commit carries an old release.mjs without `order`; GITHUB_SHA carries this one. */
  function fixture(tags: string[], workflowScript = readFileSync(script, 'utf8')) {
    const root = mkdtempSync(path.join(tmpdir(), 'release-order-workflow-'));
    dirs.push(root);
    const work = path.join(root, 'work');
    mkdirSync(path.join(work, 'scripts'), { recursive: true });
    mkdirSync(path.join(root, 'runner-temp'));
    git(root, 'init', '-q', '-b', 'main', work);
    writeFileSync(path.join(work, 'scripts/release.mjs'), "console.error('old release.mjs'); process.exit(1);\n");
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'old target');
    const target = git(work, 'rev-parse', 'HEAD');
    writeFileSync(path.join(work, 'scripts/release.mjs'), workflowScript);
    git(work, 'commit', '-qam', 'workflow commit');
    for (const tag of tags) git(work, 'tag', '-a', tag, '-m', tag);
    const origin = path.join(root, 'origin.git');
    git(root, 'clone', '-q', '--bare', work, origin);
    const checkout = path.join(root, 'checkout');
    git(root, 'clone', '-q', origin, checkout);
    git(checkout, 'checkout', '-q', '--detach', target);
    return { checkout, runnerTemp: path.join(root, 'runner-temp'), sha: git(work, 'rev-parse', 'HEAD') };
  }

  function run(f: ReturnType<typeof fixture>, version: string): string {
    return execFileSync('bash', ['-c', `set -euo pipefail\n${block}`], {
      cwd: f.checkout,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, GITHUB_SHA: f.sha, RELEASE_VERSION: version, RUNNER_TEMP: f.runnerTemp },
    });
  }

  it('runs the same block in the verify and publish jobs, after the target checks', () => {
    expect(block.split('\n').at(-1)).toBe(
      'test "$ORDER" = "v${RELEASE_VERSION} sorts above every existing tag of its version"',
    );
    const indented = lines.slice(start, start + 6).join('\n');
    expect(releaseWorkflow.split(indented)).toHaveLength(3);
    expect(releaseWorkflow.split(`git merge-base --is-ancestor "$TARGET_SHA" origin/main\n${indented}`)).toHaveLength(
      3,
    );
  });

  it('keeps release.mjs free of non-builtin imports, so its copy runs from RUNNER_TEMP', () => {
    const imports = [...readFileSync(script, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((name) => name.startsWith('node:'))).toBe(true);
  });

  it('checks the order with the workflow commit, not the target release.mjs', { timeout: 30_000 }, () => {
    const f = fixture(['v2026.10.1', 'v2026.11.0-rc.1']);
    expect(run(f, '2026.11.0-rc.2')).toBe('');
    expect(() => run(f, '2026.11.0-beta.2')).toThrow('does not sort above v2026.11.0-rc.1');
  });

  it('fails when the tag list is empty', { timeout: 30_000 }, () => {
    expect(() => run(fixture([]), '2026.11.0-beta.1')).toThrow('the tag list is empty');
  });

  it('fails when the order command exits 0 without its success line', { timeout: 30_000 }, () => {
    expect(() => run(fixture(['v2026.10.1'], 'process.exit(0);\n'), '2026.11.0-beta.1')).toThrow();
  });

  it('fails when the tag lookup fails', { timeout: 30_000 }, () => {
    const f = fixture(['v2026.10.1']);
    git(f.checkout, 'remote', 'set-url', 'origin', path.join(f.runnerTemp, 'missing.git'));
    expect(() => run(f, '2026.11.0-beta.1')).toThrow();
    expect(readFileSync(path.join(f.runnerTemp, 'release-tags.txt'), 'utf8')).toBe('');
  });
});
