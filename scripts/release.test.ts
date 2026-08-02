import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assembleReleaseBody,
  changelogSection,
  publicationPlan,
  publicationReadbackStatus,
  verifyRelease,
} from './release.mjs';

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
    expect(releaseWorkflow).toContain('EXPECTED_REVIEWERS=\'["gavrielc","omri-maya"]\'');
    expect(releaseWorkflow).toContain('Release reviewer roster drift');
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
