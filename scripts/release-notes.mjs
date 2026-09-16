#!/usr/bin/env node

// Harvests the optional fenced `release-note` block that the v2 pull request
// template (marker `nanoclaw-pr-template:v2`) asks contributors to fill in, and
// renders a draft changelog section for a maintainer to edit.
//
// This tool never writes CHANGELOG.md. It prints a draft to stdout; moving any
// of it into the changelog stays a deliberate human edit, per RELEASING.md.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Canonical order. Kept byte-identical to MANAGED_KINDS in
// .github/workflows/label-pr.yml — a PR carrying several kind labels is
// grouped under the first one listed here, so grouping is deterministic.
export const MANAGED_KINDS = ['kind/bug', 'kind/feature', 'kind/documentation', 'kind/cleanup', 'kind/hardening'];

export const KIND_HEADINGS = {
  'kind/bug': 'Fixes',
  'kind/feature': 'Features',
  'kind/documentation': 'Documentation',
  'kind/cleanup': 'Cleanup',
  'kind/hardening': 'Hardening',
};

export const UNLABELLED_HEADING = 'Unlabelled';

// The literal prompt shipped inside the template's fence. A contributor who
// never touched the block leaves this behind; it is not a release note.
const TEMPLATE_PLACEHOLDER =
  'Optional: one user-facing line for the changelog. Skip it and a maintainer will write one.';

const RELEASE_NOTE_INFO_STRINGS = new Set(['release-note', 'release-notes']);

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Returns the body of the first flush-left fenced block whose info string is
 * `release-note` (or `release-notes`), or null when there is no usable note.
 *
 * The fence grammar deliberately matches the one the v2 label workflow already
 * applies when it strips fences before parsing checkboxes: flush-left, three or
 * more backticks or tildes, closed by a run of the same character at least as
 * long. An unterminated fence runs to the end of the body, as CommonMark says.
 */
export function extractReleaseNote(body) {
  const lines = String(body ?? '')
    .replaceAll('\r\n', '\n')
    .split('\n');

  let fenceChar = null;
  let fenceLength = 0;
  let collecting = false;
  const collected = [];

  for (const line of lines) {
    if (fenceChar === null) {
      const opener = /^(`{3,}|~{3,})[ \t]*(.*)$/.exec(line);
      if (!opener) continue;
      const marker = opener[1];
      const info = opener[2].trim();
      // A backtick fence's info string may not contain a backtick (CommonMark).
      if (marker[0] === '`' && info.includes('`')) continue;
      fenceChar = marker[0];
      fenceLength = marker.length;
      collecting = RELEASE_NOTE_INFO_STRINGS.has(info.toLowerCase());
      continue;
    }

    const closer = new RegExp(`^\\${fenceChar}{${fenceLength},}[ \\t]*$`).test(line);
    if (closer) {
      if (collecting) return finishNote(collected);
      fenceChar = null;
      fenceLength = 0;
      continue;
    }
    if (collecting) collected.push(line);
  }

  return collecting ? finishNote(collected) : null;
}

function finishNote(lines) {
  let text = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '');

  // Tolerate a contributor who wrote their line under the untouched prompt.
  const withoutPlaceholder = text
    .split('\n')
    .filter((line) => collapseWhitespace(line) !== TEMPLATE_PLACEHOLDER)
    .join('\n');
  if (collapseWhitespace(withoutPlaceholder)) text = withoutPlaceholder;

  const trimmed = text.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!collapseWhitespace(trimmed)) return null;
  if (collapseWhitespace(trimmed) === TEMPLATE_PLACEHOLDER) return null;
  return trimmed;
}

/** The kind this PR is grouped under, or null when it carries no managed kind. */
export function pullRequestKind(labels) {
  const names = new Set(
    (labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean),
  );
  return MANAGED_KINDS.find((kind) => names.has(kind)) ?? null;
}

/** True when the v2 "Breaking change" box is checked outside any fenced block. */
export function isBreakingChange(body) {
  const text = String(body ?? '').replaceAll('\r\n', '\n');
  const lines = [];
  let fenceChar = null;
  let fenceLength = 0;
  for (const line of text.split('\n')) {
    const marker = /^(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (fenceChar === null) {
        fenceChar = marker[1][0];
        fenceLength = marker[1].length;
      } else if (line[0] === fenceChar && marker[1].length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceChar === null) lines.push(line);
  }
  return lines.some((line) => /^- \[x\]\s+Breaking change\b/i.test(line));
}

/**
 * Splits merged pull requests into per-kind groups of harvested notes plus the
 * list of PRs that still need a line. Input order is preserved inside a group.
 */
export function collectReleaseNotes(pullRequests) {
  const groups = new Map();
  const missing = [];

  for (const pr of pullRequests ?? []) {
    const kind = pullRequestKind(pr.labels);
    const note = extractReleaseNote(pr.body);
    const entry = {
      number: pr.number,
      title: pr.title ?? '',
      url: pr.url ?? '',
      author: pr.author ?? '',
      kind,
      breaking: isBreakingChange(pr.body),
      note,
    };

    if (note === null) {
      missing.push(entry);
      continue;
    }
    const key = kind ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const ordered = [...MANAGED_KINDS, '']
    .filter((key) => groups.has(key))
    .map((key) => ({
      kind: key || null,
      heading: key ? KIND_HEADINGS[key] : UNLABELLED_HEADING,
      entries: groups.get(key),
    }));

  return { groups: ordered, missing };
}

function attribution(entry) {
  const reference = entry.url ? `[#${entry.number}](${entry.url})` : `#${entry.number}`;
  return entry.author ? `(${reference}, @${entry.author})` : `(${reference})`;
}

function renderNoteBullet(entry) {
  const prefix = entry.breaking ? '[BREAKING] ' : '';
  const lines = `${prefix}${entry.note}`.split('\n');
  const rendered = lines.map((line, index) => (index === 0 ? `- ${line}` : line === '' ? '' : `  ${line}`));
  rendered[rendered.length - 1] += ` ${attribution(entry)}`;
  return rendered.join('\n');
}

/** Renders the whole draft. Markdown only; nothing here touches the repository. */
export function renderDraftChangelog({ groups, missing }, meta = {}) {
  const {
    since = '',
    until = '',
    total = groups.reduce((count, group) => count + group.entries.length, 0) + missing.length,
  } = meta;
  const out = ['# Draft release notes', ''];

  const range = since && until ? ` merged between \`${since}\` and \`${until}\`` : '';
  out.push(
    `_Harvested from ${total} pull request${total === 1 ? '' : 's'}${range}. ` +
      'Edit this, then move the lines you keep into `## [Unreleased]` yourself — ' +
      'this tool never writes `CHANGELOG.md`._',
    '',
  );

  if (groups.length === 0) out.push('No release notes were found in this range.', '');

  for (const group of groups) {
    out.push(`## ${group.heading}`, '');
    for (const entry of group.entries) out.push(renderNoteBullet(entry));
    out.push('');
  }

  out.push(`## Needs a line (${missing.length})`, '');
  if (missing.length === 0) {
    out.push('Every merged pull request in this range carried a release note.', '');
  } else {
    out.push(
      'These merged pull requests had no `release-note` block. Write a line for the user-visible ones, and ignore the rest.',
      '',
    );
    for (const entry of missing) {
      const kind = entry.kind ? ` \`${entry.kind}\`` : '';
      out.push(`- ${attribution(entry)}${kind} — ${entry.title}`);
    }
    out.push('');
  }

  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/** Pull request numbers referenced by the commits in a `git log` subject list. */
export function pullRequestNumbersFromLog(log) {
  const numbers = [];
  const seen = new Set();
  for (const line of String(log ?? '').split('\n')) {
    const match = /^Merge pull request #(\d+) /.exec(line) ?? /\(#(\d+)\)\s*$/.exec(line);
    if (!match) continue;
    const number = Number(match[1]);
    if (seen.has(number)) continue;
    seen.add(number);
    numbers.push(number);
  }
  return numbers.sort((a, b) => a - b);
}

export function pullRequestQuery(repository, numbers) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error(`--repo must be owner/name; got ${repository}`);
  const fields = 'number title url body author { login } labels(first: 50) { nodes { name } } mergedAt';
  const selections = numbers
    .map((number) => `    pr${number}: pullRequest(number: ${number}) { ${fields} }`)
    .join('\n');
  return `query {\n  repository(owner: "${owner}", name: "${name}") {\n${selections}\n  }\n}`;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fetchPullRequests(repository, numbers, chunkSize = 25) {
  const fetched = [];
  for (let index = 0; index < numbers.length; index += chunkSize) {
    const chunk = numbers.slice(index, index + chunkSize);
    const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${pullRequestQuery(repository, chunk)}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const node = JSON.parse(raw)?.data?.repository ?? {};
    for (const number of chunk) {
      const pr = node[`pr${number}`];
      if (!pr || !pr.mergedAt) continue;
      fetched.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        body: pr.body,
        author: pr.author?.login ?? '',
        labels: pr.labels?.nodes ?? [],
      });
    }
  }
  return fetched;
}

function parseArgs(argv) {
  const options = { since: '', until: 'HEAD', repo: 'nanocoai/nanoclaw', json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--since' || arg === '--until' || arg === '--repo') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'draft') {
    throw new Error(
      'usage: node scripts/release-notes.mjs draft [--since <ref>] [--until <ref>] [--repo owner/name] [--json]',
    );
  }

  const options = parseArgs(rest);
  const until = git(['rev-parse', options.until]).trim();
  const since = (options.since || git(['describe', '--tags', '--abbrev=0', until])).trim();

  const log = git(['log', '--format=%s', `${since}..${until}`]);
  const numbers = pullRequestNumbersFromLog(log);
  const pullRequests = fetchPullRequests(options.repo, numbers);
  const collected = collectReleaseNotes(pullRequests);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ since, until, ...collected }, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderDraftChangelog(collected, { since, until: options.until, total: pullRequests.length }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
