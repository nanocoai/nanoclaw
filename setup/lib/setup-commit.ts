/**
 * Commit what a setup skill apply wrote, as a labeled local commit.
 *
 * The updater refuses a dirty checkout, and a skill's materialized payload is
 * an install customization like any other. Only paths whose content changed
 * during the apply are committed, so an operator's own uncommitted edits stay
 * untouched. A commit failure never fails setup; it is reported instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import * as p from '@clack/prompts';

/** Dirty path → blob hash of its working-tree content, or '-' when deleted. */
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
  });
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
  const snapshot: TreeSnapshot = new Map(paths.map((file) => [file, '-']));
  const present = paths.filter((file) => existsSync(join(root, file)));
  if (present.length) {
    const hashes = git(root, ['hash-object', '--stdin-paths'], `${present.join('\n')}\n`)
      .trim()
      .split('\n');
    present.forEach((file, i) => snapshot.set(file, hashes[i]));
  }
  return snapshot;
}

function identityArgs(root: string): string[] {
  try {
    if (git(root, ['config', 'user.name']).trim() && git(root, ['config', 'user.email']).trim()) return [];
  } catch {
    /* unset on a fresh machine */
  }
  return ['-c', 'user.name=NanoClaw setup', '-c', 'user.email=setup@nanoclaw.invalid'];
}

export function commitSetupChanges(root: string, before: TreeSnapshot | null, message: string): SetupCommitResult {
  if (!before) return { committed: [] };
  try {
    const after = snapshotTree(root);
    if (!after) return { committed: [] };
    const changed = [...after].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file);
    if (!changed.length) return { committed: [] };
    const spec = `${changed.join('\0')}\0`;
    git(root, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], spec);
    git(
      root,
      [
        ...identityArgs(root),
        'commit',
        '--no-verify',
        '--quiet',
        '-m',
        message,
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
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
  const before = snapshotTree(root);
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
