/**
 * The one place every relative path an agent supplies gets turned into a
 * validated, on-disk absolute path -- or rejected. Fails closed on every
 * branch: a missing file, a ".." segment, an absolute path, a symlink
 * resolving outside the root, or a destination that already exists is
 * always a rejection, never a best-effort allow. Mirrors the discipline of
 * lease-document-delivery/resolve.ts (realpath-based containment, not
 * string-prefix comparison, so a symlink can't fool the check).
 *
 * Two shapes, because move/copy/mkdir need two different guarantees:
 *   - resolveExistingPathWithinRoot: the path must already exist and be a
 *     regular file (move/copy sources).
 *   - resolveNewPathWithinRoot: the path must NOT yet exist, but its parent
 *     folder must (move/copy destinations, mkdir targets). Never creates
 *     intermediate folders -- if the parent doesn't exist, this fails
 *     rather than silently creating a deep path.
 *
 * Ported verbatim from old commit 59de60dc -- pure fs/path logic, no DB
 * access, nothing to adapt for the async DB migration.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface PathCheckResult {
  ok: boolean;
  absolutePath?: string;
  reason?: string;
}

const DRIVE_LETTER_RE = /^[A-Za-z]:[\\/]/;

function findUnsafeSegmentReason(relativePath: string): string | null {
  if (relativePath.includes('\\')) {
    return 'backslashes are not allowed -- use forward-slash relative paths only.';
  }
  if (relativePath.startsWith('/')) {
    return 'absolute paths are not allowed -- must be relative to the Lease Manager root.';
  }
  if (DRIVE_LETTER_RE.test(relativePath)) {
    return 'absolute Windows-style paths are not allowed -- must be relative to the Lease Manager root.';
  }
  const segments = relativePath.split('/');
  for (const seg of segments) {
    if (seg === '..') return '".." path segments are not allowed.';
    if (seg === '') return 'empty path segments (e.g. a leading, trailing, or doubled "/") are not allowed.';
  }
  return null;
}

function realRootOrThrow(root: string): string {
  return fs.realpathSync(root);
}

/** Source paths: must already exist, must be a regular file. */
export function resolveExistingPathWithinRoot(root: string, relativePath: unknown): PathCheckResult {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return { ok: false, reason: 'path is required and must be a non-empty string.' };
  }
  const unsafe = findUnsafeSegmentReason(relativePath);
  if (unsafe) return { ok: false, reason: unsafe };

  const rroot = realRootOrThrow(root);
  const candidate = path.resolve(root, relativePath);

  if (!fs.existsSync(candidate)) {
    return { ok: false, reason: 'path does not exist.' };
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    return { ok: false, reason: `could not resolve path: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (real !== rroot && !real.startsWith(rroot + path.sep)) {
    return { ok: false, reason: 'path resolves outside the configured Lease Manager root.' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch (e) {
    return { ok: false, reason: `could not stat path: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: 'path is not a regular file.' };
  }

  return { ok: true, absolutePath: real };
}

/** Destination paths: must NOT yet exist; parent folder must exist and be within root. */
export function resolveNewPathWithinRoot(root: string, relativePath: unknown): PathCheckResult {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return { ok: false, reason: 'path is required and must be a non-empty string.' };
  }
  const unsafe = findUnsafeSegmentReason(relativePath);
  if (unsafe) return { ok: false, reason: unsafe };

  const rroot = realRootOrThrow(root);
  const candidate = path.resolve(root, relativePath);
  const parent = path.dirname(candidate);

  if (!fs.existsSync(parent)) {
    return {
      ok: false,
      reason: `parent folder does not exist: ${path.relative(root, parent)} -- create it first with lease_fs_mkdir if intended.`,
    };
  }

  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch (e) {
    return { ok: false, reason: `could not resolve parent folder: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (realParent !== rroot && !realParent.startsWith(rroot + path.sep)) {
    return { ok: false, reason: 'destination folder resolves outside the configured Lease Manager root.' };
  }

  const finalPath = path.join(realParent, path.basename(candidate));
  if (fs.existsSync(finalPath)) {
    return {
      ok: false,
      reason:
        'destination already exists -- refusing to overwrite. This needs an explicit decision, not an automatic one.',
    };
  }

  return { ok: true, absolutePath: finalPath };
}
