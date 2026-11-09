/**
 * Update channels: which upstream ref /update-nanoclaw merges.
 *
 *   stable (default)  newest annotated vX.Y.Z tag on the remote
 *   beta              newest vX.Y.Z-rc.N tag newer than stable, else stable
 *   edge              tip of the remote's main branch
 *
 * release.yml creates the annotated tag only when it publishes the release, so
 * the tag list is the release list. Set NANOCLAW_UPDATE_CHANNEL in .env;
 * `prepare --channel` overrides it once.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createCommandRunner, type CommandRunner } from './service.js';

export const CHANNELS = ['stable', 'beta', 'edge'] as const;
export type UpdateChannel = (typeof CHANNELS)[number];

export interface UpdateTarget {
  channel: UpdateChannel;
  ref: string;
  tag?: string;
}

export interface ResolveOptions {
  projectRoot: string;
  remote: string;
  channel: UpdateChannel;
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

function parseChannel(raw: string): UpdateChannel {
  const value = raw.trim().toLowerCase();
  if (!(CHANNELS as readonly string[]).includes(value)) {
    throw new Error(`Unknown update channel "${value}". Use one of: ${CHANNELS.join(', ')}`);
  }
  return value as UpdateChannel;
}

export function readChannelSetting(projectRoot: string, override?: string): UpdateChannel {
  return parseChannel(override ?? envValue(projectRoot, 'NANOCLAW_UPDATE_CHANNEL') ?? 'stable');
}

/** `upsert` is setup/set-env.ts's writer, loaded from the install because the archived controller cannot import setup/. */
export function writeChannelSetting(
  projectRoot: string,
  raw: string,
  upsert: (key: string, value: string, projectRoot: string) => unknown,
): UpdateChannel {
  const channel = parseChannel(raw);
  upsert('NANOCLAW_UPDATE_CHANNEL', channel, projectRoot);
  // Writers before 2.4 ignore projectRoot and use the cwd; never report a write that did not land.
  if (envValue(projectRoot, 'NANOCLAW_UPDATE_CHANNEL') !== channel) {
    throw new Error(`Could not save NANOCLAW_UPDATE_CHANNEL=${channel} to ${path.join(projectRoot, '.env')}`);
  }
  return channel;
}

/** Thrown when stable/beta would move the install backward; the skill turns it into a question. */
export class AheadOfReleaseError extends Error {
  readonly code = 'ahead-of-release';
  constructor(
    readonly channel: UpdateChannel,
    readonly tag: string,
    readonly base: string,
  ) {
    super(
      `This install already has upstream changes newer than ${tag}, the newest release on the ${channel} channel. ` +
        `Updating to it would move backward, so nothing was changed. ` +
        `To keep following main, set NANOCLAW_UPDATE_CHANNEL=edge in .env (or pass --channel edge once). ` +
        `Otherwise wait for a release that includes this install's commit (${base.slice(0, 8)}).`,
    );
  }
}

/** Annotated release tags on the remote; lightweight and non-release tags never count. */
function remoteReleaseTags(runner: CommandRunner, root: string, remote: string): string[] {
  return runner
    .run('git', ['ls-remote', '--tags', remote], root)
    .split('\n')
    .map((line) => /refs\/tags\/(.+)\^\{\}$/.exec(line.trim())?.[1])
    .filter((tag): tag is string => tag !== undefined && parseReleaseTag(tag) !== null);
}

function pickTag(tags: string[], channel: 'stable' | 'beta'): string | undefined {
  // A release sorts after its own rcs, so beta's newest is an rc only when it is newer than stable.
  const eligible = channel === 'stable' ? tags.filter((tag) => parseReleaseTag(tag)!.rc === undefined) : tags;
  return eligible.sort(compareReleaseTags).at(-1);
}

function remoteMainRef(runner: CommandRunner, root: string, remote: string): string {
  for (const branch of ['main', 'master']) {
    // Fetch it here: a stale tracking ref would hide upstream commits from the backward check.
    const fetched = runner.tryRun(
      'git',
      ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      root,
    );
    if (fetched.ok) return `${remote}/${branch}`;
  }
  throw new Error(`Remote ${remote} has neither main nor master`);
}

export function resolveUpdateTarget(options: ResolveOptions): UpdateTarget {
  const runner = options.runner ?? createCommandRunner();
  const root = options.projectRoot;
  const mainRef = remoteMainRef(runner, root, options.remote);
  if (options.channel === 'edge') return { channel: 'edge', ref: mainRef };

  const tag = pickTag(remoteReleaseTags(runner, root, options.remote), options.channel);
  if (!tag) throw new Error(`No ${options.channel} release found on ${options.remote}`);

  // No --force: a local tag that differs from upstream's must stop the update.
  const ref = `refs/tags/${tag}`;
  runner.run('git', ['fetch', '--quiet', '--no-tags', options.remote, `${ref}:${ref}`], root);

  // Compare upstream history only, so local customizations never count as "ahead".
  const base = runner.run('git', ['merge-base', 'HEAD', mainRef], root);
  if (!runner.tryRun('git', ['merge-base', '--is-ancestor', base, `${ref}^{commit}`], root).ok) {
    throw new AheadOfReleaseError(options.channel, tag, base);
  }
  return { channel: options.channel, ref, tag };
}

/** Record the channel in the marker after the target code's own `upgrade-state.ts set`. */
export function stampChannel(projectRoot: string, target: { channel: string; ref: string }): void {
  const marker = path.join(projectRoot, 'data', 'upgrade-state.json');
  const state = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(marker, `${JSON.stringify({ ...state, channel: target.channel, ref: target.ref }, null, 2)}\n`);
}
