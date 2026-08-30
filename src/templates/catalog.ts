/**
 * Template catalog — enumerate the templates available under a source, and read
 * Agent Plugins available under a source, without paying for a full clone just
 * to render a list.
 *
 * GitHub sources (the default library and any github.com URL) list via the Git
 * Trees API in one request, so the only clone is the one
 * `createAgentFromTemplate` does at stamp time for the chosen plugin. A local
 * folder reads in place. Any other git host (or an
 * unreachable GitHub API, e.g. a private repo with no token) falls back to
 * resolving the base to a temp clone and walking it.
 *
 * Total failures surface as a clean Error carrying the raw cause via `.cause` —
 * the setup UX layer shows the message and logs the cause; it never dumps git or
 * GitHub-API stderr at the operator.
 */
import fs from 'fs';
import path from 'path';

import { DEFAULT_TEMPLATES_SOURCE, resolveTemplateBase } from './source.js';

export interface TemplateEntry {
  /** Bare ref to pass to `createAgentFromTemplate` / `--template` (e.g. "sales/sdr"). */
  ref: string;
  /** Display name — the last path segment of the ref. */
  name: string;
}

interface GithubRepo {
  owner: string;
  repo: string;
}

/**
 * True when the base is a remote locator (URL/SSH), not a local filesystem path.
 * Callers gate the github fast path on this so a local checkout that merely
 * *contains* "github.com/owner/repo" (e.g. `~/go/src/github.com/acme/x`) is read
 * from disk, never sent to the GitHub API.
 */
export function isRemote(base: string): boolean {
  return /^(git\+|git@|https?:\/\/|ssh:\/\/)/i.test(base) || /\.git($|[#@])/.test(base);
}

/**
 * Parse `owner/repo` from a github.com locator, or null. Only meaningful for a
 * remote ref (gate on {@link isRemote}). Strips the `git+` scheme, any
 * `#subpath` / `@ref` tail, the `.git` suffix, and a trailing slash so
 * `…/repo.git#sub` yields `repo`, not `repo.git`.
 */
export function parseGithubRepo(base: string): GithubRepo | null {
  const core = base
    .replace(/^git\+/, '')
    // Strip a *trailing* @ref only — a clean token with no /:#, so the `@` in an
    // SSH locator (git@github.com:o/r) survives but `…r.git@v2` splits. Same rule
    // as splitSuffixes() in source.ts — keep the two in lockstep.
    .replace(/@[^@/:#]+$/, '')
    .replace(/#.*$/, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
  const m = core.match(/github\.com[/:]([^/]+)\/([^/]+)$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': 'nanoclaw-setup',
    Accept: 'application/vnd.github+json',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function ghJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

function stringField(value: unknown, key: string): string | undefined {
  if (value && typeof value === 'object') {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * A folder is a template iff it contains this marker file. Always '/'-separated
 * to match GitHub Trees paths; the local walk normalizes path.sep to '/' first.
 */
const MARKER_POSIX = 'plugin.json';

/**
 * Turn a marker-file path (relative to the source, '/'-separated) into a template
 * entry, or null when it isn't a marker. A bare marker means the source folder is
 * *itself* a template → ref `.`, which resolves back to that folder at stamp time;
 * a nested marker yields the holding folder's path as the ref.
 */
function markerToEntry(posixPath: string, rootName: string): TemplateEntry | null {
  if (posixPath === MARKER_POSIX) return { ref: '.', name: rootName };
  if (posixPath.endsWith(`/${MARKER_POSIX}`)) {
    const ref = posixPath.slice(0, -(MARKER_POSIX.length + 1));
    return { ref, name: ref.split('/').pop() ?? ref };
  }
  return null;
}

async function listViaGithub(gh: GithubRepo): Promise<TemplateEntry[]> {
  // HEAD resolves to the repo's default branch, so no extra round-trip to look it up.
  const tree = await ghJson(`https://api.github.com/repos/${gh.owner}/${gh.repo}/git/trees/HEAD?recursive=1`);
  if ((tree as { truncated?: unknown }).truncated === true) {
    throw new Error('GitHub tree truncated — too many entries to list via API');
  }
  const entries = (tree as { tree?: unknown }).tree;
  if (!Array.isArray(entries)) throw new Error('unexpected GitHub trees response');
  return entries
    .filter((e) => stringField(e, 'type') === 'blob')
    .map((e) => markerToEntry(stringField(e, 'path') ?? '', gh.repo))
    .filter((entry): entry is TemplateEntry => entry !== null)
    .sort((a, b) => a.ref.localeCompare(b.ref));
}

async function listViaWalk(source?: string): Promise<TemplateEntry[]> {
  const { dir, cleanup } = await resolveTemplateBase(source);
  try {
    const rels = fs.readdirSync(dir, { recursive: true }) as string[];
    const rootName = path.basename(path.resolve(dir));
    return rels
      .map((rel) => markerToEntry(rel.split(path.sep).join('/'), rootName))
      .filter((entry): entry is TemplateEntry => entry !== null)
      .sort((a, b) => a.ref.localeCompare(b.ref));
  } finally {
    cleanup();
  }
}

/**
 * List the templates available under `source` (defaults to the public library).
 * GitHub sources list via API (no clone); local/other-git sources resolve the
 * base and walk it. A reachable-but-failing GitHub API (private/no-token, or
 * only rate-limited — in which case a public repo still clones fine) falls back
 * to the walk so the operator's ambient git auth is used. A total failure throws
 * a clean message with the underlying cause attached.
 */
export async function listTemplates(source?: string): Promise<TemplateEntry[]> {
  const base = source ?? DEFAULT_TEMPLATES_SOURCE;
  const gh = isRemote(base) ? parseGithubRepo(base) : null;
  try {
    if (gh) {
      try {
        return await listViaGithub(gh);
      } catch {
        return await listViaWalk(source);
      }
    }
    return await listViaWalk(source);
  } catch (err) {
    throw new Error(`Could not read templates from ${base}`, { cause: err });
  }
}
