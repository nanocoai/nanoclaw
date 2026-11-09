#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_PATTERN = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-(?:beta|rc)\.[1-9]\d*$/;

export function isPrerelease(version) {
  if (PRERELEASE_PATTERN.test(version)) return true;
  if (VERSION_PATTERN.test(version)) return false;
  throw new Error(`version must be x.y.z, x.y.z-beta.N or x.y.z-rc.N without a v prefix: ${version}`);
}

// Same tags and order as scripts/update/channel.ts: beta.N < rc.N < the release.
// release.test.ts checks that the two agree.
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+)|-beta\.([1-9]\d*))?$/;

function parseTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (match[4] !== undefined) return { major, minor, patch, stage: 1, number: Number(match[4]) };
  if (match[5] !== undefined) return { major, minor, patch, stage: 0, number: Number(match[5]) };
  return { major, minor, patch, stage: 2, number: 0 };
}

export function compareTags(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  if (!x || !y) throw new Error(`Not a release tag: ${!x ? a : b}`);
  return (
    x.major - y.major || x.minor - y.minor || x.patch - y.patch || x.stage - y.stage || Math.sign(x.number - y.number)
  );
}

/** Tag names from `git ls-remote --tags` output. An empty list fails: the order check must never pass blind. */
export function tagsFromLsRemote(output) {
  const tags = new Set();
  for (const line of output.split('\n')) {
    const tag = /\trefs\/tags\/(.+?)(?:\^\{\})?$/.exec(line.trimEnd())?.[1];
    if (tag) tags.add(tag);
  }
  if (tags.size === 0) throw new Error('the tag list is empty; refusing to skip the release order check');
  return [...tags];
}

// The beta channel offers only the newest tag, so a version that does not sort above
// every existing tag of the same x.y.z would publish and never be offered.
export function verifyReleaseOrder(version, tags) {
  isPrerelease(version);
  const tag = `v${version}`;
  const wanted = parseTag(tag);
  const blockers = tags
    .filter((other) => {
      if (other === tag) return false; // a publish rerun after the tag was pushed
      const t = parseTag(other);
      return (
        t !== null &&
        t.major === wanted.major &&
        t.minor === wanted.minor &&
        t.patch === wanted.patch &&
        compareTags(other, tag) >= 0
      );
    })
    .sort(compareTags);
  if (blockers.length > 0) {
    const newest = blockers.at(-1);
    throw new Error(
      `${tag} does not sort above ${newest}, which already exists, so the beta channel would never offer it. ` +
        `Release a version that sorts after ${newest}.`,
    );
  }
}

function bulletedSection(remainder, label) {
  const nextHeading = remainder.search(/^## \[/m);
  const section = (nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)).trim();
  if (!section || !/^[-*] /m.test(section)) {
    throw new Error(`CHANGELOG.md [${label}] must contain at least one release-note bullet`);
  }
  return section;
}

// Pre-releases publish the Unreleased notes as they stand; the stable release PR moves them.
export function unreleasedSection(markdown) {
  const matches = [...markdown.matchAll(/^## \[Unreleased\]$/gm)];
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one [Unreleased] heading; found ${matches.length}`);
  }
  return bulletedSection(markdown.slice(matches[0].index + matches[0][0].length), 'Unreleased');
}

export function changelogSection(markdown, version) {
  if (isPrerelease(version)) {
    return unreleasedSection(markdown);
  }

  const escaped = version.replaceAll('.', '\\.');
  const header = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'gm');
  const matches = [...markdown.matchAll(header)];

  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one dated [${version}] heading; found ${matches.length}`);
  }

  return bulletedSection(markdown.slice(matches[0].index + matches[0][0].length), version);
}

export function verifyRelease({ changelog, packageVersion, version }) {
  if (packageVersion !== version) {
    throw new Error(`package.json version ${packageVersion} does not match requested release ${version}`);
  }

  if (isPrerelease(version)) {
    const base = version.match(PRERELEASE_PATTERN)[1];
    if (changelog.includes(`## [${base}]`)) {
      throw new Error(`${version} is a pre-release of ${base}, which CHANGELOG.md already records as released`);
    }
    return unreleasedSection(changelog);
  }

  const unreleasedIndex = changelog.indexOf('## [Unreleased]');
  const releaseIndex = changelog.indexOf(`## [${version}]`);
  if (unreleasedIndex === -1 || unreleasedIndex > releaseIndex) {
    throw new Error('CHANGELOG.md must keep [Unreleased] immediately ahead of released versions');
  }

  return changelogSection(changelog, version);
}

export function assembleReleaseBody({ changelog, generatedNotes, version }) {
  const curated = changelogSection(changelog, version);
  const changesMatch = generatedNotes.match(
    /## What's Changed\s*\n([\s\S]*?)(?=\n## New Contributors|\n\*\*Full Changelog\*\*:)/,
  );
  const fullChangelogMatch = generatedNotes.match(/^\*\*Full Changelog\*\*:.*$/m);

  if (!changesMatch?.[1].trim()) {
    throw new Error("GitHub generated notes did not contain a non-empty What's Changed section");
  }
  if (!fullChangelogMatch) {
    throw new Error('GitHub generated notes did not contain a Full Changelog link');
  }

  const newContributorsMatch = generatedNotes.match(/## New Contributors\s*\n([\s\S]*?)(?=\n\*\*Full Changelog\*\*:)/);
  const sections = [curated];

  if (newContributorsMatch?.[1].trim()) {
    sections.push(`## New Contributors\n\n${newContributorsMatch[1].trim()}`);
  }

  sections.push(`## Contributors\n\nThanks to everyone who landed work in this release:\n\n${changesMatch[1].trim()}`);
  sections.push(fullChangelogMatch[0]);

  return `${sections.join('\n\n')}\n`;
}

function normalizedBody(body) {
  if (typeof body !== 'string') {
    throw new Error('GitHub Release body must be a string');
  }
  return body.replaceAll('\r\n', '\n').trimEnd();
}

export function publicationPlan({ expectedBody, release, tagState, targetSha, version }) {
  const tag = `v${version}`;

  if (!/^[0-9a-f]{40}$/.test(targetSha)) {
    throw new Error(`target SHA must be a full lowercase 40-character commit SHA: ${targetSha}`);
  }
  if (!tagState || typeof tagState.exists !== 'boolean') {
    throw new Error('tag state must include an exists boolean');
  }

  if (tagState.exists) {
    if (tagState.type !== 'tag') {
      throw new Error(`${tag} exists but is not an annotated tag`);
    }
    if (tagState.sha !== targetSha) {
      throw new Error(`${tag} resolves to ${tagState.sha}, not workflow target ${targetSha}`);
    }
  }

  if (release !== null) {
    if (!tagState.exists) {
      throw new Error(`GitHub Release ${tag} exists but its tag was not fetched`);
    }
    if (release.tag_name !== tag) {
      throw new Error(`GitHub Release tag ${release.tag_name ?? '<missing>'} does not match ${tag}`);
    }
    if (release.name !== tag) {
      throw new Error(`GitHub Release title ${release.name ?? '<missing>'} does not match ${tag}`);
    }
    if (release.draft !== false) {
      throw new Error(`GitHub Release ${tag} is still a draft`);
    }
    if (release.prerelease !== isPrerelease(version)) {
      throw new Error(`GitHub Release ${tag} is ${release.prerelease ? '' : 'not '}marked as a prerelease`);
    }
    if (release.immutable !== true) {
      throw new Error(`GitHub Release ${tag} is not immutable`);
    }
    if (normalizedBody(release.body) !== normalizedBody(expectedBody)) {
      throw new Error(`GitHub Release ${tag} body does not match the assembled release notes`);
    }
    if (typeof release.html_url !== 'string' || !release.html_url) {
      throw new Error(`GitHub Release ${tag} has no public URL`);
    }
    return 'already-published';
  }

  return tagState.exists ? 'create-release' : 'create-tag-and-release';
}

export function publicationReadbackStatus(inputs) {
  const immutablePending = inputs.release !== null && inputs.release.immutable !== true;
  const release = immutablePending ? { ...inputs.release, immutable: true } : inputs.release;
  const plan = publicationPlan({ ...inputs, release });

  if (plan === 'already-published') {
    return immutablePending ? 'pending' : 'already-published';
  }
  if (plan === 'create-release') {
    return 'pending';
  }

  throw new Error(`post-publication read-back returned unsafe plan ${plan}`);
}

function repositoryInputs() {
  return {
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    packageVersion: JSON.parse(readFileSync('package.json', 'utf8')).version,
  };
}

export function main(argv) {
  const [command, version, ...args] = argv;
  if (!command || !version) {
    throw new Error(
      'usage: node scripts/release.mjs <verify|extract|assemble|plan|readback|order> <x.y.z[-beta.N|-rc.N]> [command arguments]',
    );
  }

  // Reads no repository files: release.yml runs this from its own commit against any target.
  if (command === 'order') {
    const [tagListPath] = args;
    if (!tagListPath) {
      throw new Error('order requires the path to a git ls-remote tag list');
    }
    verifyReleaseOrder(version, tagsFromLsRemote(readFileSync(tagListPath, 'utf8')));
    process.stdout.write(`v${version} sorts above every existing tag of its version\n`);
    return;
  }

  const inputs = repositoryInputs();
  const section = verifyRelease({ ...inputs, version });

  if (command === 'verify') {
    process.stdout.write(`release metadata verified for v${version}\n`);
    return;
  }
  if (command === 'extract') {
    process.stdout.write(`${section}\n`);
    return;
  }
  if (command === 'assemble') {
    const [generatedNotesPath] = args;
    if (!generatedNotesPath) {
      throw new Error('assemble requires the path to GitHub-generated notes');
    }
    process.stdout.write(
      assembleReleaseBody({
        changelog: inputs.changelog,
        generatedNotes: readFileSync(generatedNotesPath, 'utf8'),
        version,
      }),
    );
    return;
  }
  if (command === 'plan' || command === 'readback') {
    const [targetSha, tagStatePath, releasePath, expectedBodyPath] = args;
    if (!targetSha || !tagStatePath || !releasePath || !expectedBodyPath) {
      throw new Error(`${command} requires target SHA, tag-state JSON, release JSON, and expected release notes paths`);
    }
    const publicationInputs = {
      expectedBody: readFileSync(expectedBodyPath, 'utf8'),
      release: JSON.parse(readFileSync(releasePath, 'utf8')),
      tagState: JSON.parse(readFileSync(tagStatePath, 'utf8')),
      targetSha,
      version,
    };
    process.stdout.write(
      `${command === 'plan' ? publicationPlan(publicationInputs) : publicationReadbackStatus(publicationInputs)}\n`,
    );
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

// realpath: a symlinked argv (macOS /var) would skip main() and exit 0 having done nothing.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
