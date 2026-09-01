/**
 * Template source resolution — the one swappable seam.
 *
 * A template ref (`./x`, `sales/sdr`, `git+https://host/repo.git#sub@v1`) is
 * parsed into a `TemplateLocation`, then handed to the backend whose `scheme`
 * matches. Each backend's secret: how a ref becomes a local directory on disk
 * (verbatim path vs shallow git clone). Adding S3 later = one more
 * `TemplateSource` in `SOURCES` — no CLI or dispatcher change.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveStoredTemplateDir } from './store.js';

/** Default git repo for bare/relative refs (`sales/sdr` → this repo, subpath `sales/sdr`). */
export const DEFAULT_TEMPLATES_SOURCE = 'git+https://github.com/nanocoai/nanoclaw-templates';

/** A fetched template: a local dir to read, plus a cleanup to release any temp clone. */
export interface ResolvedTemplate {
  dir: string;
  cleanup: () => void;
}

/** A parsed ref. `base` is the backend target (path or repo); `subpath`/`ref` are optional. */
export interface TemplateLocation {
  scheme: string;
  base: string;
  subpath?: string;
  ref?: string;
}

/** A backend that turns a parsed location into a local directory. */
export interface TemplateSource {
  scheme: string;
  fetch(loc: TemplateLocation): Promise<ResolvedTemplate>;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function gitCloneUrl(base: string): string {
  // Strip the `git+` disambiguation prefix; SSH (`git@…`) and plain URLs pass through.
  return base.startsWith('git+') ? base.slice(4) : base;
}

const fileSource: TemplateSource = {
  scheme: 'file',
  async fetch(loc) {
    return { dir: path.resolve(expandHome(loc.base), loc.subpath ?? ''), cleanup: () => {} };
  },
};

const gitSource: TemplateSource = {
  scheme: 'git',
  async fetch(loc) {
    const repo = gitCloneUrl(loc.base);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tpl-'));
    try {
      const branchArgs = loc.ref ? ['--branch', loc.ref] : [];
      // Arg array + `--` before the positional → no shell, no arg injection.
      // Auth is the operator's ambient git config (credential helper / SSH key);
      // we never inject a token. GIT_TERMINAL_PROMPT=0 fails fast on a private
      // repo instead of blocking the host on a credential prompt with no TTY.
      execFileSync('git', ['clone', '--depth', '1', ...branchArgs, '--', repo, tmp], {
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    return {
      dir: loc.subpath ? path.join(tmp, loc.subpath) : tmp,
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  },
};

const SOURCES: TemplateSource[] = [fileSource, gitSource];

function isLocalPrefix(ref: string): boolean {
  return ref.startsWith('./') || ref.startsWith('../') || ref.startsWith('/') || ref.startsWith('~');
}

function isExplicitGit(ref: string): boolean {
  return ref.startsWith('git+') || ref.startsWith('git@') || /\.git($|[@#])/.test(ref);
}

function schemeOf(base: string): string {
  if (base.startsWith('git+') || base.startsWith('git@') || base.endsWith('.git')) return 'git';
  const m = base.match(/^([a-z][a-z0-9]*):\/\//i);
  return m ? m[1].toLowerCase() : 'file';
}

/** Pull a trailing `@ref` and a `#subpath` off a locator, leaving `core`. */
function splitSuffixes(raw: string): { core: string; subpath?: string; ref?: string } {
  let s = raw;
  let ref: string | undefined;
  // Only a *clean* trailing token counts as a ref — `git@host:org/repo.git`
  // keeps its `@` (the tail contains `:` and `/`), but `…repo.git@v2` splits.
  // Same rule as parseGithubRepo() in catalog.ts — keep the two in lockstep.
  const refMatch = s.match(/@([^@/:#]+)$/);
  if (refMatch) {
    ref = refMatch[1];
    s = s.slice(0, refMatch.index);
  }
  let subpath: string | undefined;
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) {
    subpath = s.slice(hashIdx + 1);
    s = s.slice(0, hashIdx);
  }
  return { core: s, subpath, ref };
}

/**
 * A plain http(s)/ssh URL is a git repo in this loader — git is the only remote
 * backend — so prepend the `git+` disambiguator and let the git path handle it.
 * This lets operators paste a normal `https://github.com/org/repo` instead of
 * the `git+` form. Already-tagged refs (git+…, git@…, ….git), local paths, and
 * future schemes (s3://) are left untouched.
 */
function normalizeRemoteGit(ref: string): string {
  return /^(https?|ssh):\/\//i.test(ref) && !ref.startsWith('git+') ? `git+${ref}` : ref;
}

/**
 * Classify a ref into a `TemplateLocation` by prefix/shape alone — never by
 * touching the filesystem, so the same ref resolves identically on any host.
 *
 * `sourceOverride` (the `--source` flag) only affects bare/relative refs; an
 * explicit URI or local path is self-contained and ignores it.
 */
export function parseTemplateRef(ref: string, sourceOverride?: string): TemplateLocation {
  ref = normalizeRemoteGit(ref);
  const source = sourceOverride ? normalizeRemoteGit(sourceOverride) : undefined;
  if (isLocalPrefix(ref)) {
    return { scheme: 'file', base: ref };
  }
  if (isExplicitGit(ref)) {
    const { core, subpath, ref: gitRef } = splitSuffixes(ref);
    return { scheme: 'git', base: core, subpath, ref: gitRef };
  }
  // Bare name (slashes allowed) → a subpath under the configured templates base.
  const { core, ref: gitRef } = splitSuffixes(ref);
  const base = source ?? DEFAULT_TEMPLATES_SOURCE;
  return { scheme: schemeOf(base), base, subpath: core, ref: gitRef };
}

/** Resolve a ref to a local template dir via the matching backend. Caller must `cleanup()`. */
export async function resolveTemplateSource(ref: string, sourceOverride?: string): Promise<ResolvedTemplate> {
  const loc = parseTemplateRef(ref, sourceOverride);
  // A bare name under a LOCAL base that has no such folder is what a stored
  // template looks like from here: the stamper asked for `seed-assistant`
  // against `templates/`, the deployment's folder library is empty by design
  // (the host's preserve floor), and the row is in the central database. The
  // folder still wins when it exists — a checkout's override — and a remote
  // base is never consulted for stored names.
  if (loc.scheme === 'file' && loc.subpath && !loc.subpath.includes('/') &&
      !fs.existsSync(path.join(path.resolve(expandHome(loc.base), loc.subpath), 'plugin.json'))) {
    const stored = await resolveStoredTemplateDir(loc.subpath);
    if (stored) return { dir: stored, cleanup: () => {} };
  }
  const source = SOURCES.find((s) => s.scheme === loc.scheme);
  if (!source) throw new Error(`unsupported template source: ${ref}`);
  return source.fetch(loc);
}

/**
 * Resolve the *base* of a templates source — the catalog root that holds many
 * templates — to a local directory, rather than one named template. Backs
 * `listTemplates`' fallback when no cheaper backend-native listing exists (a
 * local folder reads in place; a git repo is cloned whole). Caller must
 * `cleanup()`.
 */
export async function resolveTemplateBase(source?: string): Promise<ResolvedTemplate> {
  return resolveTemplateSource('', source);
}
