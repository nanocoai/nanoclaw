/**
 * Update channels: which upstream ref /update-nanoclaw merges.
 *
 *   stable (default)  newest published, non-prerelease GitHub Release vX.Y.Z
 *   beta              newest vX.Y.Z-rc.N pre-release newer than stable, else stable
 *   edge              tip of the remote's main branch
 *
 * Set NANOCLAW_UPDATE_CHANNEL in .env; `prepare --channel` overrides it once.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createCommandRunner, type CommandRunner } from './service.js';

export const CHANNELS = ['stable', 'beta', 'edge'] as const;
export type UpdateChannel = (typeof CHANNELS)[number];

export interface ReleaseInfo {
  tag: string;
  draft: boolean;
  prerelease: boolean;
}

export interface UpdateTarget {
  channel: UpdateChannel;
  ref: string;
  tag?: string;
  source: 'github-release' | 'annotated-tag' | 'branch';
  note?: string;
}

export interface ResolveOptions {
  projectRoot: string;
  remote: string;
  channel: UpdateChannel;
  fetchReleases?: (remoteUrl: string) => Promise<ReleaseInfo[]>;
  runner?: CommandRunner;
}

interface ParsedTag {
  major: number;
  minor: number;
  patch: number;
  rc?: number;
}

// Only release tags; the remote also carries pre-update-*, pre-squash/* and similar.
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

export function parseReleaseTag(tag: string): ParsedTag | null {
  const match = RELEASE_TAG.exec(tag);
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  return match[4] === undefined ? { major, minor, patch } : { major, minor, patch, rc: Number(match[4]) };
}

/** Numeric per field, so CalVer v2026.10.0 sorts after v2.4.0; a release sorts after its rcs. */
export function compareReleaseTags(a: string, b: string): number {
  const x = parseReleaseTag(a);
  const y = parseReleaseTag(b);
  if (!x || !y) throw new Error(`Not a release tag: ${!x ? a : b}`);
  const rank = (t: ParsedTag) => (t.rc === undefined ? Number.POSITIVE_INFINITY : t.rc);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch || Math.sign(rank(x) - rank(y)) || 0;
}

/** Same KEY=value rules as src/env.ts, which the archived controller cannot import. */
function envValue(projectRoot: string, key: string): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1 || trimmed.slice(0, eqIdx).trim() !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (value) found = value;
  }
  return found;
}

export function readChannelSetting(projectRoot: string, override?: string): UpdateChannel {
  const value = (override ?? envValue(projectRoot, 'NANOCLAW_UPDATE_CHANNEL') ?? 'stable').trim().toLowerCase();
  if (!(CHANNELS as readonly string[]).includes(value)) {
    throw new Error(`Unknown update channel "${value}". Use one of: ${CHANNELS.join(', ')}`);
  }
  return value as UpdateChannel;
}

function githubRepo(remoteUrl: string): string | null {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl);
  return match ? `${match[1]}/${match[2]}` : null;
}

export async function fetchGithubReleases(remoteUrl: string): Promise<ReleaseInfo[]> {
  const repo = githubRepo(remoteUrl);
  if (!repo) throw new Error(`${remoteUrl} is not a GitHub remote`);
  const releases: ReleaseInfo[] = [];
  // Every page: many release candidates can push the newest stable release off page one.
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub releases API returned ${response.status}`);
    const body = (await response.json()) as Array<{ tag_name: string; draft: boolean; prerelease: boolean }>;
    releases.push(...body.map((item) => ({ tag: item.tag_name, draft: item.draft, prerelease: item.prerelease })));
    if (body.length < 100) break;
  }
  return releases;
}

/** Fallback when the API is unreachable: annotated release tags straight from the remote. */
function annotatedRemoteTags(runner: CommandRunner, root: string, remote: string): ReleaseInfo[] {
  const peeled = runner
    .run('git', ['ls-remote', '--tags', remote], root)
    .split('\n')
    .map((line) => /refs\/tags\/(.+)\^\{\}$/.exec(line.trim())?.[1])
    .filter((tag): tag is string => tag !== undefined);
  return peeled.map((tag) => ({ tag, draft: false, prerelease: parseReleaseTag(tag)?.rc !== undefined }));
}

function pickTag(list: ReleaseInfo[], channel: 'stable' | 'beta'): string | undefined {
  const published = list.filter((item) => !item.draft && parseReleaseTag(item.tag));
  const newest = (tags: string[]) => tags.sort(compareReleaseTags).at(-1);
  const stable = newest(
    published.filter((i) => !i.prerelease && parseReleaseTag(i.tag)!.rc === undefined).map((i) => i.tag),
  );
  if (channel === 'stable') return stable;
  const rc = newest(
    published.filter((i) => i.prerelease && parseReleaseTag(i.tag)!.rc !== undefined).map((i) => i.tag),
  );
  if (rc && (!stable || compareReleaseTags(rc, stable) > 0)) return rc;
  return stable;
}

function remoteMainRef(runner: CommandRunner, root: string, remote: string): string {
  for (const branch of ['main', 'master']) {
    const ref = `${remote}/${branch}`;
    if (runner.tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`], root).ok) return ref;
  }
  throw new Error(`Remote ${remote} has neither main nor master`);
}

export async function resolveUpdateTarget(options: ResolveOptions): Promise<UpdateTarget> {
  const runner = options.runner ?? createCommandRunner();
  const root = options.projectRoot;
  const mainRef = remoteMainRef(runner, root, options.remote);
  if (options.channel === 'edge') return { channel: 'edge', ref: mainRef, source: 'branch' };

  const remoteUrl = runner.run('git', ['remote', 'get-url', options.remote], root);
  let source: UpdateTarget['source'] = 'github-release';
  let note: string | undefined;
  let tag: string | undefined;
  try {
    tag = pickTag(await (options.fetchReleases ?? fetchGithubReleases)(remoteUrl), options.channel);
    if (!tag) throw new Error(`no ${options.channel} release listed`);
  } catch (err) {
    source = 'annotated-tag';
    note = `GitHub releases unavailable (${err instanceof Error ? err.message : String(err)}); used the newest annotated release tag on ${options.remote}`;
    tag = pickTag(annotatedRemoteTags(runner, root, options.remote), options.channel);
  }
  if (!tag) throw new Error(`No ${options.channel} release found on ${options.remote}`);

  // No --force: a local tag that differs from upstream's must stop the update.
  const ref = `refs/tags/${tag}`;
  runner.run('git', ['fetch', '--quiet', '--no-tags', options.remote, `${ref}:${ref}`], root);

  // Compare upstream history only, so local customizations never count as "ahead".
  const base = runner.run('git', ['merge-base', 'HEAD', mainRef], root);
  if (!runner.tryRun('git', ['merge-base', '--is-ancestor', base, `${ref}^{commit}`], root).ok) {
    throw new Error(
      `This install already has upstream changes newer than ${tag}, the newest release on the ${options.channel} channel. ` +
        `Updating to it would move backward, so nothing was changed. ` +
        `To keep following main, set NANOCLAW_UPDATE_CHANNEL=edge in .env (or pass --channel edge once). ` +
        `Otherwise wait for a release that includes this install's commit (${base.slice(0, 8)}).`,
    );
  }
  return { channel: options.channel, ref, tag, source, ...(note ? { note } : {}) };
}

/** Record the channel in the marker after the target code's own `upgrade-state.ts set`. */
export function stampChannel(projectRoot: string, target: { channel: string; ref: string }): void {
  const marker = path.join(projectRoot, 'data', 'upgrade-state.json');
  const state = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(marker, `${JSON.stringify({ ...state, channel: target.channel, ref: target.ref }, null, 2)}\n`);
}
