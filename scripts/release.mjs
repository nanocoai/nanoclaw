#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function changelogSection(markdown, version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`version must be an exact x.y.z value without a v prefix: ${version}`);
  }

  const escaped = version.replaceAll('.', '\\.');
  const header = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'gm');
  const matches = [...markdown.matchAll(header)];

  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one dated [${version}] heading; found ${matches.length}`);
  }

  const start = matches[0].index + matches[0][0].length;
  const remainder = markdown.slice(start);
  const nextHeading = remainder.search(/^## \[/m);
  const section = (nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)).trim();

  if (!section || !/^[-*] /m.test(section)) {
    throw new Error(`CHANGELOG.md [${version}] must contain at least one release-note bullet`);
  }

  return section;
}

export function verifyRelease({ changelog, packageVersion, version }) {
  if (packageVersion !== version) {
    throw new Error(`package.json version ${packageVersion} does not match requested release ${version}`);
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
    if (release.prerelease !== false) {
      throw new Error(`GitHub Release ${tag} is marked as a prerelease`);
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
      'usage: node scripts/release.mjs <verify|extract|assemble|plan|readback> <x.y.z> [command arguments]',
    );
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
