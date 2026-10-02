/**
 * Commit what a setup skill apply wrote, as a labeled local commit.
 *
 * The updater refuses a dirty checkout, and a skill's materialized payload is
 * an install customization like any other. Only paths whose content changed
 * during the apply are committed, so an operator's own uncommitted edits stay
 * untouched. A commit failure never fails setup; it is reported instead.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import * as p from '@clack/prompts';

/** Dirty path → fingerprint of its working-tree entry (type, mode, content), or '-' when absent. */
export type TreeSnapshot = Map<string, string>;

export interface SetupCommitResult {
  committed: string[];
  error?: string;
}

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function fingerprint(file: string): string {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(file)}`;
    if (!stat.isFile()) return 'other';
    const exec = stat.mode & 0o100 ? 'x' : '-';
    return `${exec}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
  } catch {
    return '-';
  }
}

/** Null when `root` is not the top of its own Git checkout: nothing to commit into. */
export function snapshotTree(root: string): TreeSnapshot | null {
  try {
    if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== realpathSync(root)) return null;
  } catch {
    return null;
  }
  const paths = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  return new Map(paths.map((file) => [file, fingerprint(join(root, file))]));
}

// A fresh machine may have no Git identity. Set one on this checkout only:
// the updater later merges upstream into these commits and needs it too.
function ensureIdentity(root: string): void {
  for (const [key, value] of [
    ['user.name', 'NanoClaw setup'],
    ['user.email', 'setup@nanoclaw.invalid'],
  ]) {
    try {
      if (git(root, ['config', key]).trim()) continue;
    } catch {
      /* unset */
    }
    git(root, ['config', '--local', key, value]);
  }
}

export function commitSetupChanges(root: string, before: TreeSnapshot | null, message: string): SetupCommitResult {
  if (!before) return { committed: [] };
  try {
    const after = snapshotTree(root);
    if (!after) return { committed: [] };
    const changed = [...after].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file);
    if (!changed.length) return { committed: [] };
    const spec = `${changed.join('\0')}\0`;
    ensureIdentity(root);
    // Machine-made local commits: no hooks, no signing prompt mid-setup.
    const quiet = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false'];
    git(root, [...quiet, 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], spec);
    git(
      root,
      [...quiet, 'commit', '--no-verify', '--quiet', '-m', message, '--pathspec-from-file=-', '--pathspec-file-nul'],
      spec,
    );
    return { committed: changed };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    return { committed: [], error: stderr || (err instanceof Error ? err.message : String(err)) };
  }
}

/** Run one skill apply and commit its changes, even when the apply throws. */
export async function withSetupCommit<T>(
  root: string,
  label: string,
  apply: () => Promise<T>,
  onError: (error: string) => void,
): Promise<T> {
  // Contributors running setup in a dev clone can keep these commits off
  // their feature branch; they then commit (or discard) the files themselves.
  if (process.env.NANOCLAW_SETUP_COMMIT === '0') return apply();
  let before: TreeSnapshot | null = null;
  try {
    before = snapshotTree(root);
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err));
  }
  try {
    return await apply();
  } finally {
    const result = commitSetupChanges(root, before, `setup: apply ${label}`);
    if (result.error) onError(result.error);
  }
}

export function warnSetupCommit(error: string): void {
  p.log.warn(
    `Couldn't commit the files setup just added (${error}). Commit them before updating: git add -A && git commit`,
  );
}
