import fs from 'node:fs';
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

/** The pinned Bun writes the lockfile the image build reads with --frozen-lockfile. */
function regenerateCommand(runner: CommandRunner, root: string, file: string): [string, string[]] {
  const args = ['install', '--lockfile-only', '--ignore-scripts'];
  if (LOCKFILES[file].manager === 'pnpm') return ['pnpm', args];
  const version = pinnedBunVersion(root);
  const host = runner.tryRun('bun', ['--version'], root);
  if (host.ok && host.stdout.trim() === version) return ['bun', args];
  return ['pnpm', [`--package=bun@${version}`, 'dlx', 'bun', ...args]];
}

interface Snapshot {
  index: string;
  modified: Set<string>;
  untracked: Set<string>;
}

/** The index and every changed path besides the lockfiles, to compare after a regenerate. */
function snapshot(runner: CommandRunner, root: string, files: string[]): Snapshot {
  const others = (args: string[]) => new Set(lines(runner.run('git', args, root)).filter((f) => !files.includes(f)));
  return {
    index: runner.run('git', ['ls-files', '--stage'], root),
    modified: others(['diff', '--name-only']),
    untracked: others(['ls-files', '--others', '--exclude-standard']),
  };
}

function changedSince(runner: CommandRunner, root: string, files: string[], before: Snapshot) {
  const after = snapshot(runner, root, files);
  return {
    index: after.index !== before.index,
    modified: [...after.modified].filter((f) => !before.modified.has(f)),
    untracked: [...after.untracked].filter((f) => !before.untracked.has(f)),
  };
}

/** Put back what a failed regenerate added; an index change can only be reported. */
function undoStrays(runner: CommandRunner, root: string, files: string[], before: Snapshot): string | undefined {
  const stray = changedSince(runner, root, files, before);
  if (stray.modified.length > 0) runner.tryRun('git', ['checkout', '--', ...stray.modified], root);
  for (const file of stray.untracked) fs.rmSync(path.join(root, file), { force: true });
  return stray.index ? 'The git index changed too: abandon this update and prepare it again.' : undefined;
}

const MANUAL_STEPS =
  "To do it by hand in the stage: take upstream's copy (git checkout --theirs -- <file>), regenerate it " +
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
  const files = unmerged.filter(isLockfile);
  if (files.length === 0) return { kind: 'none' };
  if (files.length < unmerged.length) return { kind: 'mixed', files };

  const before = snapshot(runner, root, files);
  const fail = (reason: string): LockfileOutcome => {
    const leftover = undoStrays(runner, root, files, before);
    runner.tryRun('git', ['checkout', '-m', '--', ...files], root);
    return {
      kind: 'failed',
      files,
      message:
        `Only lockfiles conflicted (${files.join(', ')}), but regenerating them failed: ${reason}\n` +
        (leftover ? `${leftover}\n` : '') +
        MANUAL_STEPS,
    };
  };

  for (const file of files) {
    const theirs = runner.tryRun('git', ['checkout', '--theirs', '--', file], root);
    if (!theirs.ok) return fail(`upstream has no ${file} to start from: ${tail(theirs.stdout)}`);
  }
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
  const stray = changedSince(runner, root, files, before);
  if (stray.index || stray.modified.length + stray.untracked.length > 0) {
    const what = [...stray.modified, ...stray.untracked, ...(stray.index ? ['the git index'] : [])];
    return fail(`it also changed ${what.join(', ')}`);
  }

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
  return { kind: 'resolved', files };
}

/** What to tell the operator about lockfiles in a merge that stays conflicted. */
export function lockfileNote(outcome: LockfileOutcome): string | undefined {
  if (outcome.kind === 'failed') return outcome.message;
  if (outcome.kind === 'mixed') {
    return (
      `Do not edit ${outcome.files.join(', ')}: resolve and git add the other files, ` +
      'then run resume without committing. Resume regenerates the lockfiles and commits the merge.'
    );
  }
  return undefined;
}
