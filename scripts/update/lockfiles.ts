import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { pinnedBunVersion } from '../provider-contract-verifier.js';
import type { CommandRunner } from './service.js';

/** Lockfiles the update can rebuild from the merged manifest, and where. */
const LOCKFILES: Record<string, { dir: string; manager: 'pnpm' | 'bun' }> = {
  'pnpm-lock.yaml': { dir: '.', manager: 'pnpm' },
  'container/agent-runner/bun.lock': { dir: 'container/agent-runner', manager: 'bun' },
};

const REGENERATE_TIMEOUT_MS = 10 * 60 * 1000;

export type LockfileOutcome =
  | { kind: 'none' }
  | { kind: 'mixed'; files: string[] }
  | { kind: 'blocked'; files: string[]; others: string[] }
  | { kind: 'resolved'; files: string[] }
  | { kind: 'failed'; files: string[]; message: string };

function isLockfile(file: string): boolean {
  return Object.hasOwn(LOCKFILES, file);
}

function lines(output: string): string[] {
  return output.split('\n').filter(Boolean);
}

function tail(output: string): string {
  return lines(output).slice(-15).join('\n') || '(no output)';
}

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})( |$)/m;

/** Lockfiles whose copy in the stage still has conflict markers. */
export function markedLockfiles(root: string): string[] {
  return Object.keys(LOCKFILES).filter((file) => {
    const target = path.join(root, file);
    return fs.existsSync(target) && CONFLICT_MARKER.test(fs.readFileSync(target, 'utf8'));
  });
}

/** Refuse a stage that would commit or install a lockfile with conflict markers. */
export function assertLockfilesUnmarked(root: string, upstreamRef: string): void {
  const marked = markedLockfiles(root);
  if (marked.length === 0) return;
  throw new Error(
    `${marked.join(', ')} in the stage still has conflict markers. Never merge a lockfile by hand: ` +
      `take a clean copy (git checkout ${upstreamRef} -- <file>), regenerate it ` +
      '(pnpm install --lockfile-only, or bun install --lockfile-only in container/agent-runner), ' +
      'commit, then resume.',
  );
}

/** The pinned Bun writes the lockfile the image build reads with --frozen-lockfile. */
function regenerateCommand(runner: CommandRunner, root: string, file: string): [string, string[]] {
  const args = ['install', '--lockfile-only', '--ignore-scripts'];
  if (LOCKFILES[file].manager === 'pnpm') return ['pnpm', args];
  const version = pinnedBunVersion(root);
  const host = runner.tryRun('bun', ['--version'], root);
  if (host.ok && host.stdout.trim() === version) return ['bun', args];
  return ['pnpm', [`--package=bun@${version}`, 'dlx', 'bun', ...args]];
}

/** Paths besides the lockfiles that differ from the index, and untracked files. */
function otherChanges(
  runner: CommandRunner,
  root: string,
  files: string[],
): { modified: string[]; untracked: string[] } {
  const others = (args: string[]) =>
    runner
      .run('git', [...args, '-z'], root)
      .split('\0')
      .filter((file) => file && !files.includes(file));
  return {
    modified: others(['diff', '--name-only']),
    untracked: others(['ls-files', '--others', '--exclude-standard']),
  };
}

const MANUAL_STEPS =
  "To do it by hand in the stage: take upstream's copy (git checkout MERGE_HEAD -- <file>), regenerate it " +
  '(pnpm install --lockfile-only, or bun install --lockfile-only in container/agent-runner), ' +
  'git add it, commit, then resume. Never merge a lockfile by hand.';

/**
 * Finish a merge whose only conflicts are lockfiles: take upstream's copy (it
 * carries upstream's lockfile-only security bumps), let the package manager add
 * back local dependencies from the merged manifest, and commit. A failure before
 * the commit puts the conflict back as git left it.
 */
export function resolveLockfileConflicts(runner: CommandRunner, root: string): LockfileOutcome {
  if (!runner.tryRun('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root).ok) return { kind: 'none' };
  const unmerged = lines(runner.run('git', ['diff', '--name-only', '--diff-filter=U'], root));
  const conflicted = unmerged.filter(isLockfile);
  // A `git add` with markers still in a lockfile drops it from the list above,
  // but upstream's copy fixes it the same way.
  const files = [...conflicted, ...markedLockfiles(root).filter((file) => !conflicted.includes(file))];
  if (files.length === 0) return { kind: 'none' };
  if (conflicted.length < unmerged.length) return { kind: 'mixed', files };

  // The clean check refuses anything else anyway, and starting clean means
  // every later change besides the lockfiles is the package manager's.
  const dirty = otherChanges(runner, root, files);
  const others = [...dirty.modified, ...dirty.untracked];
  if (others.length > 0) return { kind: 'blocked', files, others };

  // A copy of the index keeps git's conflict stages, so a failure can restore them exactly.
  const index = path.resolve(root, runner.run('git', ['rev-parse', '--git-path', 'index'], root));
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-lockfiles-'));
  const backup = path.join(backupDir, 'index');
  fs.copyFileSync(index, backup);
  const fail = (reason: string): LockfileOutcome => {
    fs.copyFileSync(backup, index);
    const stray = otherChanges(runner, root, files);
    if (stray.modified.length > 0) runner.tryRun('git', ['checkout', '--', ...stray.modified], root);
    for (const file of stray.untracked) fs.rmSync(path.join(root, file), { force: true });
    runner.tryRun('git', ['checkout', '-m', '--', ...files], root);
    return {
      kind: 'failed',
      files,
      message: `Only lockfiles conflicted (${files.join(', ')}), but regenerating them failed: ${reason}\n${MANUAL_STEPS}`,
    };
  };

  try {
    for (const file of files) {
      const theirs = runner.tryRun('git', ['checkout', 'MERGE_HEAD', '--', file], root);
      if (!theirs.ok) return fail(`upstream has no ${file} to start from: ${tail(theirs.stdout)}`);
    }
    // Taken after the checkout above, which stages upstream's copy itself.
    const listing = runner.run('git', ['ls-files', '--stage'], root);
    for (const file of files) {
      let command: [string, string[]];
      try {
        command = regenerateCommand(runner, root, file);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const cwd = path.join(root, LOCKFILES[file].dir);
      const result = runner.tryRun(command[0], command[1], cwd, { timeoutMs: REGENERATE_TIMEOUT_MS });
      if (!result.ok) return fail(`${command[0]} ${command[1].join(' ')}:\n${tail(result.stdout)}`);
    }
    // A package manager that touched anything else did more than regenerate.
    const stray = otherChanges(runner, root, files);
    const indexChanged = runner.run('git', ['ls-files', '--stage'], root) !== listing;
    const what = [...stray.modified, ...stray.untracked, ...(indexChanged ? ['the git index'] : [])];
    if (what.length > 0) return fail(`it also changed ${what.join(', ')}`);
    const marked = markedLockfiles(root);
    if (marked.length > 0) return fail(`${marked.join(', ')} still has conflict markers`);

    runner.run('git', ['add', '--', ...files], root);
    const committed = runner.tryRun('git', ['commit', '--no-edit'], root);
    if (!committed.ok) {
      return {
        kind: 'failed',
        files,
        message:
          `Regenerated and staged ${files.join(', ')}, but the merge commit failed:\n${tail(committed.stdout)}\n` +
          'Commit the merge in the stage, then resume.',
      };
    }
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  return { kind: 'resolved', files };
}

/** What to tell the operator about lockfiles in a merge that stays conflicted. */
export function lockfileNote(outcome: LockfileOutcome): string | undefined {
  if (outcome.kind === 'failed') return outcome.message;
  if (outcome.kind === 'blocked') {
    const shown = outcome.others.slice(0, 10).join(', ');
    const more = outcome.others.length > 10 ? ` and ${outcome.others.length - 10} more` : '';
    return (
      `Did not regenerate ${outcome.files.join(', ')}: the stage has changes that are not added ` +
      `(${shown}${more}). git add or remove them, then resume.`
    );
  }
  if (outcome.kind === 'mixed') {
    return (
      `Do not edit ${outcome.files.join(', ')}: resolve and git add the other files, ` +
      'then run resume without committing. Resume regenerates the lockfiles and commits the merge.'
    );
  }
  return undefined;
}
