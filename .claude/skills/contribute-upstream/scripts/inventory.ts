import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONTRIB_DIR, DEFAULTS, flagValue, flagValues } from './config.js';

export interface FileChange {
  readonly status: string;
  readonly path: string;
}

export interface EditChurn {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

export interface Divergence {
  readonly id: string;
  readonly title: string;
}

export interface LedgerEntry {
  readonly slug: string;
  readonly decision: string;
  readonly status: string;
}

export const LEDGER_DECISIONS = ['pending', 'contribute', 'keep-local', 'ask-later'] as const;

const REGISTRY_BRANCHES = ['channels', 'providers'] as const;
const EXCLUDED_PREFIXES = ['groups/', 'data/', 'logs/', `${CONTRIB_DIR}/`];
const TOP_LEVEL_AREA_DEPTH: Readonly<Record<string, number>> = { container: 4 };
const DEFAULT_AREA_DEPTH = 2;
const ROOT_AREA = '(root)';

export function parseNameStatus(output: string, extraExcludes: readonly string[] = []): FileChange[] {
  const excluded = [...EXCLUDED_PREFIXES, ...extraExcludes];
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .map((parts) => ({ status: parts[0].charAt(0), path: parts[parts.length - 1] }))
    .filter((change) => !excluded.some((prefix) => change.path.startsWith(prefix)));
}

export function parseNumstat(output: string): EditChurn[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .map(([added, removed, path]) => ({
      path,
      added: Number.parseInt(added, 10) || 0,
      removed: Number.parseInt(removed, 10) || 0,
    }));
}

export function parseDivergences(markdown: string): Divergence[] {
  return [...markdown.matchAll(/^## (D\d+)\s+[—-]\s+(.+)$/gm)].map((match) => ({
    id: match[1],
    title: match[2].trim(),
  }));
}

const SLUG_CELL = /^`[^`]+`$/;

export function parseLedger(markdown: string): LedgerEntry[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((row) =>
      row
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .map((cells) => ({ cells, slugAt: cells.findIndex((cell) => SLUG_CELL.test(cell)) }))
    .filter(({ slugAt }) => slugAt >= 0)
    .map(({ cells, slugAt }) => ({
      slug: cells[slugAt].replace(/`/g, ''),
      decision: cells[slugAt + 3] ?? 'pending',
      status: cells[slugAt + 6] ?? '',
    }));
}

export function areaOf(path: string): string {
  const segments = path.split('/');
  if (segments.length === 1) {
    return ROOT_AREA;
  }
  const depth = TOP_LEVEL_AREA_DEPTH[segments[0]] ?? DEFAULT_AREA_DEPTH;
  return segments.slice(0, Math.min(depth, segments.length - 1)).join('/');
}

export function relativeToArea(area: string, path: string): string {
  return area === ROOT_AREA ? path : path.slice(area.length + 1);
}

export function groupByArea(paths: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const area = areaOf(path);
    groups.set(area, [...(groups.get(area) ?? []), path]);
  }
  return new Map([...groups].sort((a, b) => b[1].length - a[1].length));
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(args: readonly string[]): string {
  try {
    return git(args);
  } catch {
    return '';
  }
}

function registryRemote(upstreamRef: string): string {
  return upstreamRef.split('/')[0];
}

function skillOwnedPaths(upstreamRef: string): Set<string> {
  const remote = registryRemote(upstreamRef);
  const owned = new Set<string>();
  for (const branch of REGISTRY_BRANCHES) {
    tryGit(['ls-tree', '-r', '--name-only', `${remote}/${branch}`])
      .split('\n')
      .filter(Boolean)
      .forEach((path) => owned.add(path));
  }
  const skillsDir = '.claude/skills';
  for (const skill of existsSync(skillsDir) ? readdirSync(skillsDir) : []) {
    const payload = join(skillsDir, skill, 'payload');
    tryGit(['ls-files', payload])
      .split('\n')
      .filter(Boolean)
      .forEach((path) => owned.add(path.slice(payload.length + 1)));
  }
  return owned;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

interface InventoryOptions {
  readonly upstreamRef: string;
  readonly ledgerPath: string;
  readonly divergencesPath: string;
  readonly excludes: readonly string[];
}

function renderInventory(options: InventoryOptions): string {
  const { upstreamRef } = options;
  const mergeBase = git(['merge-base', 'HEAD', upstreamRef]).trim();
  const changes = parseNameStatus(git(['diff', '--name-status', '-M', mergeBase, 'HEAD']), options.excludes);
  const owned = skillOwnedPaths(upstreamRef);
  const added = changes.filter((change) => change.status === 'A').map((change) => change.path);
  const localOnly = added.filter((path) => !owned.has(path));
  const skillOwned = added.filter((path) => owned.has(path));
  const modified = new Set(changes.filter((change) => change.status !== 'A').map((change) => change.path));
  const churn = parseNumstat(git(['diff', '--numstat', mergeBase, 'HEAD']))
    .filter((edit) => modified.has(edit.path))
    .sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const ledger = parseLedger(readIfExists(options.ledgerPath));
  const divergenceSection = existsSync(options.divergencesPath)
    ? [
        `## Permanent divergences`,
        ...parseDivergences(readFileSync(options.divergencesPath, 'utf8')).map(
          (divergence) => `- ${divergence.id} — ${divergence.title}`,
        ),
        ``,
      ]
    : [];

  const lines: string[] = [
    `# Local feature inventory`,
    ``,
    `Upstream ref: \`${upstreamRef}\` · merge-base: \`${mergeBase.slice(0, 12)}\``,
    `Local-only files: ${localOnly.length} · skill-owned files: ${skillOwned.length} · upstream files edited: ${churn.length}`,
    ``,
    ...divergenceSection,
    `## Local-only files by area`,
    ...[...groupByArea(localOnly)].map(
      ([area, paths]) =>
        `- \`${area}\` (${paths.length}): ${paths.map((path) => relativeToArea(area, path)).join(', ')}`,
    ),
    ``,
    `## Upstream files edited (seam candidates, by churn)`,
    ...churn.map((edit) => `- \`${edit.path}\` +${edit.added}/-${edit.removed}`),
    ``,
    `## Skill-owned files (not contributable as local features)`,
    ...[...groupByArea(skillOwned)].map(([area, paths]) => `- \`${area}\` (${paths.length})`),
    ``,
    `## Ledger decisions`,
    ...(ledger.length === 0
      ? ['- (none yet)']
      : ledger.map((entry) => `- \`${entry.slug}\`: ${entry.decision}${entry.status ? ` · ${entry.status}` : ''}`)),
  ];
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const options: InventoryOptions = {
    upstreamRef: flagValue(argv, '--upstream-ref', DEFAULTS.upstreamRef),
    ledgerPath: flagValue(argv, '--ledger', DEFAULTS.ledger),
    divergencesPath: flagValue(argv, '--divergences', DEFAULTS.divergences),
    excludes: flagValues(argv, '--exclude'),
  };
  if (!tryGit(['rev-parse', '--verify', options.upstreamRef])) {
    console.error(
      `upstream ref ${options.upstreamRef} not found — run: git fetch ${registryRemote(options.upstreamRef)} --prune`,
    );
    process.exit(2);
  }
  console.log(renderInventory(options));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
