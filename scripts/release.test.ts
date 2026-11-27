import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  assembleReleaseBody,
  changelogSection,
  channelBranches,
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
      'EXPECTED_REVIEWERS=\'["amit-shafnir","gavrielc","glifocat","omri-maya","zvi-fried"]\'\n              PREVENT_SELF_REVIEW=false',
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

  it('proves the target is on main before any setup action or target code runs, in both jobs', () => {
    const at = (needle: string) => {
      const found: number[] = [];
      for (let i = releaseWorkflow.indexOf(needle); i !== -1; i = releaseWorkflow.indexOf(needle, i + 1)) found.push(i);
      return found;
    };
    const checkout = at('ref: ${{ inputs.target_sha }}');
    const onMain = at('git merge-base --is-ancestor "$TARGET_SHA" origin/main');
    const firstSetup = Math.min(
      ...['uses: pnpm/action-setup', 'uses: actions/setup-node', 'uses: oven-sh/setup-bun'].map((s) => at(s)[0]),
    );
    const targetCode = at('node scripts/release.mjs verify "$RELEASE_VERSION"');
    expect(checkout).toHaveLength(2);
    expect(onMain).toHaveLength(2);
    expect(targetCode).toHaveLength(2);
    // verify job: checkout, then the git-only guard, then setup actions and target code.
    expect(checkout[0]).toBeLessThan(onMain[0]);
    expect(onMain[0]).toBeLessThan(firstSetup);
    expect(firstSetup).toBeLessThan(targetCode[0]);
    // publish job (no setup actions): the guard still runs before target code.
    expect(targetCode[0]).toBeLessThan(checkout[1]);
    expect(checkout[1]).toBeLessThan(onMain[1]);
    expect(onMain[1]).toBeLessThan(targetCode[1]);
    expect(at('uses: pnpm/action-setup')).toHaveLength(1);
    expect(at('uses: actions/setup-node')).toHaveLength(1);
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

describe('channel branches', () => {
  const existing = ['v2026.10.0', 'v2026.10.1-rc.1', 'v2026.11.0-beta.1', 'pre-update-1'];

  it('moves stable and beta to a release that is the newest tag', () => {
    expect(channelBranches('2026.11.0', existing)).toEqual(['stable', 'beta']);
    // A publish rerun finds its own tag already in the list.
    expect(channelBranches('2026.11.0', [...existing, 'v2026.11.0'])).toEqual(['stable', 'beta']);
  });

  it('moves only beta for the newest pre-release', () => {
    expect(channelBranches('2026.11.0-beta.2', existing)).toEqual(['beta']);
    expect(channelBranches('2026.11.0-rc.1', existing)).toEqual(['beta']);
  });

  it('moves only stable for a release older than the newest pre-release', () => {
    expect(channelBranches('2026.10.1', existing)).toEqual(['stable']);
  });

  it('moves nothing for a patch or pre-release of an older line', () => {
    expect(channelBranches('2026.9.5', existing)).toEqual([]);
    expect(channelBranches('2026.10.1-rc.2', existing)).toEqual([]);
  });

  it('picks the tags the updater picks, and the workflow moves the branches last', () => {
    const tags = ['v2026.10.0', 'v2026.11.0-rc.2', 'v2026.11.0-beta.4'];
    expect([...tags].sort(compareReleaseTags).at(-1)).toBe('v2026.11.0-rc.2');
    expect(channelBranches('2026.11.0-rc.2', tags)).toEqual(['beta']);
    expect(releaseWorkflow).toContain('release-order.mjs" branches "$RELEASE_VERSION"');
    expect(releaseWorkflow).toContain('-f sha="$TARGET_SHA" -F force=false');
    // The default token cannot pass the branches' ruleset: without the App token the step says what to push, then fails.
    expect(releaseWorkflow).toContain('GH_TOKEN: ${{ steps.app.outputs.token }}');
    expect(releaseWorkflow).toContain('An admin must run: \\`git push origin ${TARGET_SHA}:refs/heads/${BRANCH}\\`');
    expect(releaseWorkflow.indexOf('- name: Move the channel branches')).toBeGreaterThan(
      releaseWorkflow.indexOf('node scripts/release.mjs readback'),
    );
  });
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

  it('passes a publish rerun whose own tag was already pushed, even once a newer tag exists', () => {
    expect(() => verifyReleaseOrder('2026.11.0-beta.1', [...existing, 'v2026.11.0-beta.1'])).not.toThrow();
    expect(() => verifyReleaseOrder('2026.11.0', [...existing, 'v2026.11.0-rc.1', 'v2026.11.0'])).not.toThrow();
    const later = [...existing, 'v2026.11.0-beta.1', 'v2026.11.0-beta.2', 'v2026.11.0-rc.1', 'v2026.11.0'];
    expect(() => verifyReleaseOrder('2026.11.0-beta.1', later)).not.toThrow();
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
    for (const flags of [[], ['--preserve-symlinks-main']]) {
      expect(() =>
        execFileSync(
          process.execPath,
          [...flags, path.join(dir, 'release.mjs'), 'order', '2026.11.0-beta.1', 'tags.txt'],
          { cwd: dir, stdio: 'pipe' },
        ),
      ).toThrow('does not sort above v2026.11.0-rc.1');
    }
  });

  it('can be imported from a script on stdin without running main()', () => {
    const out = execFileSync(process.execPath, ['--input-type=module', '-'], {
      input: `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); console.log(typeof m.verifyReleaseOrder);`,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(out).toBe('function\n');
  });

  it('fails without a tag list', () => {
    expect(() => order('2026.11.0-beta.1')).toThrow('order requires the path to a git ls-remote tag list');
    expect(() => order('2026.11.0-beta.1', '')).toThrow('the tag list is empty');
  });
});

/** Git for fixture repositories: a fixed identity, and no signing or hooks from the machine's own config. */
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

describe('release workflow target check', () => {
  const steps = ['Verify target is on main', 'Re-verify immutable release inputs'];
  const lines = releaseWorkflow.split('\n');
  const after = (from: number, text: string) => lines.findIndex((line, i) => i > from && line.includes(text));
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The step's script through the on-main check: what has to pass before any target code runs. */
  function guard(step: string): string {
    const first = after(after(-1, `- name: ${step}`), 'run: |') + 1;
    return lines
      .slice(first, after(first, 'git merge-base --is-ancestor "$TARGET_SHA" origin/main') + 1)
      .map((line) => line.trim())
      .join('\n');
  }

  /** A checkout detached at the target, as actions/checkout leaves it; origin's main is one commit ahead. */
  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), 'release-target-workflow-'));
    dirs.push(root);
    const origin = path.join(root, 'origin');
    git(root, 'init', '-q', '-b', 'main', origin);
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'target');
    const target = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'later on main');
    const checkout = path.join(root, 'checkout');
    git(root, 'clone', '-q', origin, checkout);
    git(checkout, 'checkout', '-q', '--detach', target);
    return { checkout, target };
  }

  const run = (step: string, checkout: string, targetSha: string) =>
    spawnSync('bash', ['-c', guard(step)], {
      cwd: checkout,
      encoding: 'utf8',
      env: { ...process.env, TARGET_SHA: targetSha },
    });

  it.each(steps)('%s: refuses a target that is not the checked-out commit', { timeout: 30_000 }, (step) => {
    const { checkout, target } = fixture();
    expect(run(step, checkout, target).status).toBe(0);
    // The target is still a commit on main, but the code in the checkout is now another commit.
    git(checkout, 'checkout', '-q', '--detach', 'origin/main');
    expect(run(step, checkout, target).status).toBe(1);
  });

  it.each(steps)('%s: refuses a target that is not a full lowercase SHA, and says so', { timeout: 30_000 }, (step) => {
    const { checkout, target } = fixture();
    for (const malformed of [target.slice(0, 12), target.toUpperCase(), `${target}0`, 'main']) {
      expect(run(step, checkout, malformed)).toMatchObject({
        status: 1,
        stdout: '::error::target_sha must be a full lowercase 40-character commit SHA\n',
      });
    }
  });
});

describe('release workflow main protection check', () => {
  type Step = { name?: string; if?: string; run?: string };
  const verify = parseYaml(releaseWorkflow).jobs.verify as { steps: Step[] };
  const names = verify.steps.map((s) => s.name);
  const step = verify.steps.find((s) => s.name === 'Verify main protects the release workflow')!;
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const teamRule = (patterns: string[], minimumApprovals = 1, type = 'Team') => ({
    type: 'pull_request',
    ruleset_id: 1,
    parameters: {
      required_approving_review_count: 1,
      required_reviewers: [{ file_patterns: patterns, minimum_approvals: minimumApprovals, reviewer: { id: 7, type } }],
    },
  });

  /** Runs the step's script with `gh` stubbed to print main's active rules, one per line, as `--jq '.[]'` does. */
  function run(rules: unknown[], apiFails = false) {
    const root = mkdtempSync(path.join(tmpdir(), 'release-main-rules-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'bin'));
    writeFileSync(path.join(root, 'rules.jsonl'), rules.map((rule) => JSON.stringify(rule)).join('\n'));
    writeFileSync(
      path.join(root, 'bin/gh'),
      [
        '#!/bin/sh',
        `[ "$*" = "api --paginate repos/nanocoai/nanoclaw/rules/branches/main?per_page=100 --jq .[]" ] || exit 2`,
        apiFails ? 'exit 1' : `cat '${path.join(root, 'rules.jsonl')}'`,
      ].join('\n'),
      { mode: 0o755 },
    );
    return spawnSync('bash', ['-c', step.run!], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'nanocoai/nanoclaw',
        RUNNER_TEMP: root,
      },
    });
  }

  it('runs for stable versions, after the environment check and before any target code', () => {
    expect(step.if).toBe("${{ !contains(inputs.version, '-') }}");
    expect(names.indexOf('Verify main protects the release workflow')).toBe(
      names.indexOf('Verify protected release environment') + 1,
    );
  });

  it('passes when a team must approve every change under .github/', { timeout: 30_000 }, () => {
    expect(run([{ type: 'deletion' }, teamRule(['.github/**'])]).status).toBe(0);
    // Another active ruleset may hold the rule.
    expect(run([teamRule(['src/**']), teamRule(['.github/**', 'container/**'], 2)]).status).toBe(0);
  });

  it('fails closed without that rule or a readable rule list', { timeout: 30_000 }, () => {
    for (const rules of [
      [],
      [{ type: 'pull_request', parameters: { required_approving_review_count: 1, required_reviewers: [] } }],
      [{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }],
      [teamRule(['.github/**'], 0)],
      [teamRule(['.github/workflows/**'])],
      [teamRule(['.github/**', '!.github/workflows/release.yml'])],
      [teamRule(['.github/**'], 1, 'User')],
    ]) {
      expect(run(rules).status).not.toBe(0);
    }
    expect(run([teamRule(['.github/**'])], true).status).not.toBe(0);
    expect(run([]).stdout).toContain("::error::main must require a team's approval (at least 1) for .github/**");
  });
});

describe('release workflow stable publish approval', () => {
  type Step = { name?: string; if?: string; env?: Record<string, string>; run?: string };
  const publish = parseYaml(releaseWorkflow).jobs.publish as { permissions: unknown; steps: Step[] };
  const step = publish.steps.find((s) => s.name === 'Check stable publish approval')!;
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  type Person = { id: number | null; login: string; type: string };
  const ids: Record<string, number> = { glifocat: 1, 'zvi-fried': 2, gavrielc: 3 };
  const person = (login: string, type = 'User'): Person => ({ id: ids[login.toLowerCase()] ?? 99, login, type });
  const who = (p: string | Person) => (typeof p === 'string' ? person(p) : p);
  const approval = (user: string | Person, environment = 'release', state = 'approved') => ({
    state,
    comment: '',
    user: who(user),
    environments: [{ name: environment }],
  });

  /** Runs the step's script on attempt 3, with `gh` stubbed to answer the attempt and approval-history reads. */
  function run(
    history: unknown,
    actor: string | Person,
    triggering: string | Person = actor,
    failing?: 'attempts' | 'approvals',
  ) {
    const root = mkdtempSync(path.join(tmpdir(), 'release-approval-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'bin'));
    const attempt = { run_attempt: 3, actor: who(actor), triggering_actor: who(triggering) };
    writeFileSync(path.join(root, 'attempts.json'), JSON.stringify(attempt));
    writeFileSync(path.join(root, 'approvals.json'), JSON.stringify(history));
    const answer = (read: 'attempts' | 'approvals') =>
      failing === read ? 'exit 1' : `cat '${path.join(root, `${read}.json`)}'`;
    writeFileSync(
      path.join(root, 'bin/gh'),
      [
        '#!/bin/sh',
        'case "$*" in',
        `  "api repos/nanocoai/nanoclaw/actions/runs/42/attempts/3") ${answer('attempts')} ;;`,
        `  "api repos/nanocoai/nanoclaw/actions/runs/42/approvals") ${answer('approvals')} ;;`,
        '  *) exit 2 ;;',
        'esac',
      ].join('\n'),
      { mode: 0o755 },
    );
    const summary = path.join(root, 'summary.md');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-c', step.run!], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'nanocoai/nanoclaw',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '3',
        GITHUB_STEP_SUMMARY: summary,
        RUNNER_TEMP: root,
        RUN_ACTOR: attempt.actor.login,
        RUN_TRIGGERING_ACTOR: attempt.triggering_actor.login,
        SELF_APPROVAL_ALLOWLIST: step.env!.SELF_APPROVAL_ALLOWLIST,
      },
    });
    return { status: result.status, stdout: result.stdout, summary: readFileSync(summary, 'utf8') };
  }

  it('runs first in the stable publish job, with read access to the run and the allowlist in the workflow', () => {
    expect(publish.steps[0]).toBe(step);
    expect(step.if).toBe("${{ !contains(inputs.version, '-') }}");
    expect(publish.permissions).toEqual({ actions: 'read', contents: 'write' });
    expect(step.env).toMatchObject({
      SELF_APPROVAL_ALLOWLIST: 'glifocat',
      RUN_ACTOR: '${{ github.actor }}',
      RUN_TRIGGERING_ACTOR: '${{ github.triggering_actor }}',
    });
    // A refusal must stop the job: nothing may run on after a failed step.
    expect(releaseWorkflow).not.toMatch(/continue-on-error|always\(\)|failure\(\)|cancelled\(\)/);
  });

  it('passes an approval by a second release reviewer', { timeout: 30_000 }, () => {
    const result = run([approval('zvi-fried')], 'gavrielc');
    expect(result.status).toBe(0);
    expect(result.summary).toContain('- Approved by: `zvi-fried`');
    expect(result.summary).toContain('- Result: approved by a second person');
    expect(run([approval('zvi-fried', 'Release')], 'gavrielc').status).toBe(0);
  });

  it('passes a self-approval by an allowlisted maintainer, whatever the login case', { timeout: 30_000 }, () => {
    expect(run([approval('glifocat')], 'glifocat').status).toBe(0);
    const result = run([approval('glifocat')], 'Glifocat', 'zvi-fried');
    expect(result.status).toBe(0);
    expect(result.summary).toContain('- Result: self-approved by allowlisted maintainer glifocat');
  });

  it('refuses a self-approval by anyone else, as dispatcher or re-runner, in any attempt', { timeout: 30_000 }, () => {
    const refused = run([approval('gavrielc')], 'gavrielc');
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain(
      '::error::Stable publish refused: self-approved by gavrielc, who is not on SELF_APPROVAL_ALLOWLIST.',
    );
    expect(refused.summary).toContain('- Result: self-approved by gavrielc, who is not on SELF_APPROVAL_ALLOWLIST');
    expect(run([approval('Zvi-Fried')], 'glifocat', 'zvi-fried').status).toBe(1);
    expect(run([approval('zvi-fried')], 'zvi-fried', 'glifocat').status).toBe(1);
    // A second person approved one attempt; the dispatcher approved another.
    expect(run([approval('zvi-fried'), approval('gavrielc')], 'gavrielc').status).toBe(1);
    // Same account under a new login: the account id still matches.
    expect(run([approval({ id: 3, login: 'gavrielc-renamed', type: 'User' })], 'gavrielc').status).toBe(1);
  });

  it('refuses a run started or re-run by an app instead of a person', { timeout: 30_000 }, () => {
    const bot = { id: 41898282, login: 'github-actions[bot]', type: 'Bot' };
    const refused = run([approval('zvi-fried')], bot);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('::error::Stable publish refused: started by github-actions[bot], not a person.');
    expect(run([approval('glifocat')], 'zvi-fried', bot).status).toBe(1);
  });

  it('fails closed without an approval of the release environment or a readable history', { timeout: 30_000 }, () => {
    for (const history of [
      [],
      [approval('zvi-fried', 'prerelease')],
      [approval('zvi-fried', 'release', 'rejected')],
      [approval('zvi-fried', 'release', 'pending')],
      [approval('')],
      [approval({ id: null, login: 'zvi-fried', type: 'User' })],
      [{ ...approval('zvi-fried'), user: null }],
      { message: 'Not Found' },
    ]) {
      expect(run(history, 'gavrielc').status).not.toBe(0);
    }
    expect(run([approval('zvi-fried')], 'gavrielc', 'gavrielc', 'approvals').status).not.toBe(0);
    expect(run([approval('zvi-fried')], 'gavrielc', 'gavrielc', 'attempts').status).not.toBe(0);
    // Without a known dispatcher or re-runner there is nothing to compare the approver to.
    expect(run([approval('zvi-fried')], '', 'gavrielc').status).not.toBe(0);
    expect(run([approval('zvi-fried')], { id: null, login: 'gavrielc', type: 'User' }).status).not.toBe(0);
    expect(run([], 'glifocat').stdout).toContain(
      '::error::Stable publish refused: no approval of the release environment in this run.',
    );
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
    const at = (needle: string) => {
      const found: number[] = [];
      for (let i = releaseWorkflow.indexOf(needle); i !== -1; i = releaseWorkflow.indexOf(needle, i + 1)) found.push(i);
      return found;
    };
    const order = at(lines.slice(start, start + 6).join('\n'));
    const checkout = at('ref: ${{ inputs.target_sha }}');
    const onMain = at('git merge-base --is-ancestor "$TARGET_SHA" origin/main');
    expect([order.length, checkout.length, onMain.length]).toEqual([2, 2, 2]);
    // By position, not adjacency: each job proves the target is on main before the order check.
    expect(onMain[0]).toBeLessThan(order[0]);
    expect(order[0]).toBeLessThan(checkout[1]);
    expect(checkout[1]).toBeLessThan(onMain[1]);
    expect(onMain[1]).toBeLessThan(order[1]);
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

describe('release workflow channel branch step', () => {
  const lines = releaseWorkflow.split('\n');
  const stepScript = (step: string) => {
    const name = lines.findIndex((line) => line.includes(`- name: ${step}`));
    const runAt = lines.findIndex((line, i) => i > name && line.trim() === 'run: |');
    const end = lines.findIndex((line, i) => i > runAt && line.trim() !== '' && !line.startsWith('          '));
    return lines
      .slice(runAt + 1, end === -1 ? undefined : end)
      .map((line) => line.trim())
      .join('\n');
  };
  const planScript = stepScript('Plan the channel branch moves');
  const moveScript = stepScript('Move the channel branches');
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** origin has v2026.10.0 and `existing` branches on it; the target is the next commit, with the channel helper unless `helper` is false. */
  function fixture(options: { helper?: boolean; existing?: string[] } = {}) {
    const root = mkdtempSync(path.join(tmpdir(), 'release-branches-workflow-'));
    dirs.push(root);
    const work = path.join(root, 'work');
    const runnerTemp = path.join(root, 'runner-temp');
    const bin = path.join(root, 'bin');
    mkdirSync(runnerTemp);
    mkdirSync(bin);
    git(root, 'init', '-q', '-b', 'main', work);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'v2026.10.0');
    git(work, 'tag', '-a', 'v2026.10.0', '-m', 'v2026.10.0');
    if (options.helper ?? true) {
      mkdirSync(path.join(work, 'setup/lib'), { recursive: true });
      writeFileSync(path.join(work, 'setup/lib/update-channel.sh'), '# helper\n');
      git(work, 'add', '.');
    }
    git(work, 'commit', '-q', '--allow-empty', '-m', 'target');
    const target = git(work, 'rev-parse', 'HEAD');
    for (const branch of options.existing ?? []) git(work, 'branch', branch, 'v2026.10.0');
    const origin = path.join(root, 'origin.git');
    git(root, 'clone', '-q', '--bare', work, origin);
    const checkout = path.join(root, 'checkout');
    git(root, 'clone', '-q', origin, checkout);
    git(checkout, 'checkout', '-q', '--detach', target);
    writeFileSync(
      path.join(runnerTemp, 'release-order.mjs'),
      readFileSync(fileURLToPath(new URL('./release.mjs', import.meta.url)), 'utf8'),
    );
    // gh records each call; the call matching GH_FAIL fails like a refused API request.
    writeFileSync(
      path.join(bin, 'gh'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_LOG"\n' +
        'if [ -n "${GH_FAIL:-}" ]; then case "$*" in *"$GH_FAIL"*) echo "gh: refused (HTTP 422)" >&2; exit 1 ;; esac; fi\n' +
        // The read-backs: the tag (annotated unless TAG_TYPE says not), the release, each branch tip.
        'case "$*" in\n' +
        '  *git/ref/tags/*) if [ "$TAG_TYPE" = commit ]; then echo "commit $TAG_COMMIT"; else echo "tag tagobject"; fi ;;\n' +
        '  *git/tags/tagobject*) echo "commit $TAG_COMMIT" ;;\n' +
        '  *releases/tags/*) echo "$RELEASED" ;;\n' +
        '  *git/ref/heads/stable*) [ -n "$TIP_STABLE" ] || exit 1; echo "$TIP_STABLE" ;;\n' +
        '  *git/ref/heads/beta*) [ -n "$TIP_BETA" ] || exit 1; echo "$TIP_BETA" ;;\n' +
        'esac\n',
      { mode: 0o755 },
    );
    // Real git, except that looking up LOOKUP_FAIL's branch fails like a network error.
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      path.join(bin, 'git'),
      '#!/bin/sh\nif [ "$1" = ls-remote ] && [ -n "${LOOKUP_FAIL:-}" ] && [ "$5" = "refs/heads/${LOOKUP_FAIL}" ]; then\n' +
        `  echo "fatal: unable to access origin" >&2; exit 128\nfi\nexec '${realGit}' "$@"\n`,
      { mode: 0o755 },
    );
    return { bin, checkout, runnerTemp, target };
  }

  /** Runs the plan step, then the move step with the plan's outputs, as the job does. */
  function run(
    f: ReturnType<typeof fixture>,
    options: {
      token?: string;
      ghFail?: string;
      lookupFail?: string;
      moves?: string;
      version?: string;
      tagCommit?: string;
      tagType?: 'tag' | 'commit';
      released?: string;
      tips?: { stable?: string; beta?: string };
    } = {},
  ) {
    const summary = path.join(f.runnerTemp, 'summary.md');
    const ghLog = path.join(f.runnerTemp, 'gh.log');
    const output = path.join(f.runnerTemp, 'output');
    writeFileSync(summary, '');
    writeFileSync(ghLog, '');
    writeFileSync(output, '');
    const env = {
      ...process.env,
      PATH: `${f.bin}:${process.env.PATH}`,
      GH_FAIL: options.ghFail ?? '',
      GH_LOG: ghLog,
      LOOKUP_FAIL: options.lookupFail ?? '',
      GITHUB_REPOSITORY: 'nanocoai/nanoclaw',
      GITHUB_STEP_SUMMARY: summary,
      RELEASE_VERSION: options.version ?? '2026.11.0',
      TARGET_SHA: f.target,
    };
    // The plan step gets no token at all.
    delete env.GH_TOKEN;
    const plan = spawnSync('bash', ['-c', planScript], {
      cwd: f.checkout,
      encoding: 'utf8',
      env: { ...env, GITHUB_OUTPUT: output, RUNNER_TEMP: f.runnerTemp },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    // Actions stops the job when a step fails, so the move step never runs then.
    if (plan.status !== 0) throw new Error(`plan step failed: ${plan.stdout}${plan.stderr}`);
    const move = spawnSync('bash', ['-c', moveScript], {
      cwd: f.checkout,
      encoding: 'utf8',
      env: {
        ...env,
        GH_TOKEN: options.token ?? 'app-token',
        TAG_COMMIT: options.tagCommit ?? f.target,
        TAG_TYPE: options.tagType ?? 'tag',
        RELEASED: options.released ?? `false true ${(options.version ?? '2026.11.0').includes('-')}`,
        TIP_STABLE: options.tips?.stable ?? '',
        TIP_BETA: options.tips?.beta ?? '',
        MOVES: options.moves ?? outputs.moves ?? '',
        PLAN_FAILED: outputs.failed ?? '',
      },
    });
    const log = readFileSync(ghLog, 'utf8').split('\n').filter(Boolean);
    // Moves only; the tag read-back is checked on its own.
    const calls = log.filter((line) => line.startsWith('api -X'));
    return {
      lookups: log.filter((line) => !line.startsWith('api -X')),
      planStatus: plan.status,
      status: move.status,
      stdout: plan.stdout + move.stdout,
      summary: readFileSync(summary, 'utf8'),
      calls,
    };
  }

  const patch = (branch: string, sha: string) =>
    `api -X PATCH repos/nanocoai/nanoclaw/git/refs/heads/${branch} -f sha=${sha} -F force=false`;
  const post = (branch: string, sha: string) =>
    `api -X POST repos/nanocoai/nanoclaw/git/refs -f ref=refs/heads/${branch} -f sha=${sha}`;

  it('moves an existing branch only forward and creates a missing one', { timeout: 30_000 }, () => {
    const f = fixture({ existing: ['stable'] });
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([patch('stable', f.target), post('beta', f.target)]);
    expect(result.summary).toContain(`- Branch \`stable\`: \`${f.target}\``);
    expect(result.summary).toContain(`- Branch \`beta\`: \`${f.target}\``);
  });

  it('still moves beta when stable is refused, then fails the job', { timeout: 30_000 }, () => {
    const f = fixture({ existing: ['stable'] });
    const result = run(f, { ghFail: 'heads/stable' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([patch('stable', f.target), post('beta', f.target)]);
    expect(result.summary).toContain('- Branch `stable` NOT moved: the API refused it');
    expect(result.summary).toContain(`- Branch \`beta\`: \`${f.target}\``);
    expect(result.stdout).toContain('::error::Channel branches not moved: stable.');
  });

  it('fails the job without the app token, after saying what an admin must push', { timeout: 30_000 }, () => {
    const f = fixture({ existing: ['stable'] });
    const result = run(f, { token: '' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    for (const branch of ['stable', 'beta']) {
      expect(result.summary).toContain(`An admin must run: \`git push origin ${f.target}:refs/heads/${branch}\``);
      expect(result.stdout).toContain(`::error::Branch ${branch} was not moved: no channel-branch App token.`);
    }
    expect(result.stdout).toContain('::error::Channel branches not moved: stable beta.');
  });

  it('passes once an admin has pushed both branches, even without the token', { timeout: 30_000 }, () => {
    const f = fixture();
    const origin = path.join(path.dirname(f.checkout), 'origin.git');
    git(origin, 'update-ref', 'refs/heads/stable', f.target);
    git(origin, 'update-ref', 'refs/heads/beta', f.target);
    for (const token of ['', 'app-token']) {
      const result = run(f, { token });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual([]);
      expect(result.summary).toContain(`- Branch \`stable\`: \`${f.target}\` (already there)`);
      expect(result.summary).toContain(`- Branch \`beta\`: \`${f.target}\` (already there)`);
    }
  });

  it('never creates a branch whose lookup failed, and still moves the other', { timeout: 30_000 }, () => {
    const f = fixture();
    const result = run(f, { lookupFail: 'stable' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([post('beta', f.target)]);
    expect(result.summary).toContain('- Branch `stable` NOT moved: the lookup failed');
    expect(result.stdout).toContain('::error::Channel branches not moved: stable.');
  });

  it('creates beta only from a release that has the channel helper', { timeout: 30_000 }, () => {
    const f = fixture({ helper: false });
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([post('stable', f.target)]);
    expect(result.summary).toContain('- Branch `beta` NOT created: v2026.11.0 predates setup/lib/update-channel.sh.');
    // Without the app token, no admin is told to push it either; only stable fails the job.
    const manual = run(f, { token: '' });
    expect(manual.status).toBe(1);
    expect(manual.calls).toEqual([]);
    expect(manual.stdout).toContain('::error::Channel branches not moved: stable.');
    expect(manual.summary).toContain(`git push origin ${f.target}:refs/heads/stable`);
    expect(manual.summary).not.toContain('refs/heads/beta');
  });

  it('plans without the token and moves without running code from disk', { timeout: 30_000 }, () => {
    const f = fixture({ existing: ['stable'] });
    const result = run(f);
    expect(result.planStatus).toBe(0);
    expect(result.calls).toEqual([patch('stable', f.target), post('beta', f.target)]);
    const plan = releaseWorkflow.slice(
      releaseWorkflow.indexOf('- name: Plan the channel branch moves'),
      releaseWorkflow.indexOf('\n  channel-branches:'),
    );
    expect(plan.length).toBeGreaterThan(0);
    expect(plan).not.toContain('secrets.');
    expect(plan).not.toContain('GH_TOKEN');
    // The only program it runs is `gh api` (the tag read-back, then the moves); every other line
    // is shell syntax or a builtin. (`git push` appears in the admin's message text alone.)
    const programs = moveScript
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      // A command substitution, or `&&` before anything but a test, can run anything: those lines always count.
      .filter(
        (line) =>
          /\$\(|`|&&\s*[^[\s]/.test(line.replace(/\\`/g, '')) ||
          !/^(echo |set |FAILED=|BRANCH=|ALLOWED=|ANNOTATED=|ARGS=|for |do$|done$|case |esac$|fi$|then$|else$|if \[|elif |continue$|exit |;;$|\*\)|stable:update|true\)|-X )/.test(
            line,
          ),
      );
    expect(programs).toEqual([
      'TAG=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/tags/v${RELEASE_VERSION}" --jq \'.object.type + " " + .object.sha\') || TAG=""',
      'TAG=$(gh api "repos/${GITHUB_REPOSITORY}/git/tags/${TAG#* }" --jq \'.object.type + " " + .object.sha\') || TAG=""',
      'RELEASED=$(gh api "repos/${GITHUB_REPOSITORY}/releases/tags/v${RELEASE_VERSION}" --jq \'[.draft, .immutable, .prerelease] | map(tostring) | join(" ")\') || RELEASED=""',
      'CURRENT=$(gh api "repos/${GITHUB_REPOSITORY}/git/ref/heads/${BRANCH}" --jq \'.object.sha\' 2>/dev/null) || CURRENT=""',
      'if ! gh api "${ARGS[@]}" >/dev/null; then',
    ]);
  });

  it('refuses a planned move it does not expect', { timeout: 30_000 }, () => {
    const f = fixture();
    const result = run(f, { moves: 'main:update stable:create' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([post('stable', f.target)]);
    expect(result.stdout).toContain('::error::Unexpected planned move: main:update');
    expect(result.stdout).toContain('::error::Channel branches not moved: main:update.');
  });

  it('never moves stable for a pre-release, whatever the plan says', { timeout: 30_000 }, () => {
    const f = fixture({ existing: ['stable', 'beta'] });
    const result = run(f, { version: '2026.11.0-beta.1', moves: 'stable:update unexpected:beta:create beta:update' });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([patch('beta', f.target)]);
    expect(result.stdout).toContain('::error::Unexpected planned move: stable:update');
    expect(result.stdout).toContain('::error::Unexpected planned move: unexpected:beta:create');
  });

  it("hands the plan step's outputs to the channel-branches job", () => {
    type Step = { id?: string; name?: string; env?: Record<string, string>; uses?: string; with?: object };
    type Job = { needs?: string; environment?: string; permissions?: object; outputs?: object; steps: Step[] };
    const jobs = (parseYaml(releaseWorkflow) as { jobs: Record<string, Job> }).jobs;
    const plan = jobs.publish.steps.find((step) => step.name === 'Plan the channel branch moves');
    expect(plan?.id).toBe('channel-plan');
    expect(jobs.publish.steps.at(-1)).toBe(plan);
    expect(jobs.publish.outputs).toEqual({
      channel_moves: '${{ steps.channel-plan.outputs.moves }}',
      channel_failed: '${{ steps.channel-plan.outputs.failed }}',
    });
    const job = jobs['channel-branches'];
    expect(job.needs).toBe('publish');
    expect(job.environment).toBe('channel-branches');
    expect(job.permissions).toEqual({});
    // No checkout and no repository code: the App mint, then the API calls.
    expect(job.steps.map((step) => step.name)).toEqual([
      'Mint the channel branch App token',
      'Move the channel branches',
    ]);
    expect(job.steps[0]).toMatchObject({
      id: 'app',
      uses: expect.stringMatching(/^actions\/create-github-app-token@[0-9a-f]{40}$/),
    });
    expect(job.steps[1].env).toEqual({
      GH_TOKEN: '${{ steps.app.outputs.token }}',
      MOVES: '${{ needs.publish.outputs.channel_moves }}',
      PLAN_FAILED: '${{ needs.publish.outputs.channel_failed }}',
      RELEASE_VERSION: '${{ inputs.version }}',
      TARGET_SHA: '${{ inputs.target_sha }}',
    });
    expect(planScript).toContain('echo "moves=${MOVES# }" >> "$GITHUB_OUTPUT"');
    expect(planScript).toContain('echo "failed=${FAILED# }" >> "$GITHUB_OUTPUT"');
  });

  it('moves nothing when the published tag names another commit', { timeout: 30_000 }, () => {
    const f = fixture({ existing: ['stable'] });
    const result = run(f, { tagCommit: 'f'.repeat(40) });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([]);
    expect(result.lookups).toEqual([
      'api repos/nanocoai/nanoclaw/git/ref/tags/v2026.11.0 --jq .object.type + " " + .object.sha',
      'api repos/nanocoai/nanoclaw/git/tags/tagobject --jq .object.type + " " + .object.sha',
      'api repos/nanocoai/nanoclaw/releases/tags/v2026.11.0 --jq [.draft, .immutable, .prerelease] | map(tostring) | join(" ")',
    ]);
    expect(result.stdout).toContain(`::error::Tag v2026.11.0 does not point at ${f.target}`);
  });

  it(
    'moves nothing for a lightweight tag or a release that is not published and immutable',
    { timeout: 30_000 },
    () => {
      // tag type, then draft / immutable / prerelease
      for (const options of [
        { tagType: 'commit' as const },
        { released: 'true true false' },
        { released: 'false false false' },
        { released: 'false true true' },
        { released: '' },
      ]) {
        const f = fixture({ existing: ['stable'] });
        const result = run(f, options);
        expect(result.status).toBe(1);
        expect(result.calls).toEqual([]);
        expect(result.summary).toContain('is not an annotated tag on');
      }
      // A pre-release version must be a GitHub pre-release too.
      const f = fixture({ existing: ['beta'] });
      const result = run(f, { version: '2026.12.0-beta.1', moves: 'beta:update', released: 'false true false' });
      expect(result.status).toBe(1);
      expect(result.calls).toEqual([]);
      expect(result.summary).toContain('want `false true true`');
    },
  );

  it('skips a branch an earlier attempt already moved, so a retry can finish', { timeout: 30_000 }, () => {
    const f = fixture();
    const result = run(f, { moves: 'stable:create beta:create', tips: { stable: f.target } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([post('beta', f.target)]);
    expect(result.summary).toContain(`- Branch \`stable\`: already at \`${f.target}\``);
  });
});
