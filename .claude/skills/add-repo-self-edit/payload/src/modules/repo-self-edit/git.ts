/**
 * Git primitives for repo self-edits.
 *
 * The checkout may hold someone else's uncommitted work, so two rules hold
 * everywhere here: only the patch's own files are staged and committed
 * (`git commit -- <files>`, never `-A`), and a bad edit is undone with a
 * new commit reversing just those files — never `git reset --hard`, which
 * would discard whatever else is sitting in the tree.
 */
import { execFileSync } from 'child_process';

/** Commits made here carry this identity, so self-edits are findable in `git log`. */
const IDENTITY = ['-c', 'user.name=NanoClaw self-edit', '-c', 'user.email='];

type Attempt = { ok: true; out: string } | { ok: false; error: string };
export type GitResult = { ok: true; sha: string } | { ok: false; error: string };

function git(root: string, args: string[], input?: string): Attempt {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: 'pipe' }) };
    // eslint-disable-next-line no-catch-all/no-catch-all -- every git failure is returned to the caller as a value
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || String(err)).trim() };
  }
}

function lines(out: string): string[] {
  return out.split('\n').filter(Boolean);
}

export function head(root: string): string {
  const r = git(root, ['rev-parse', 'HEAD']);
  if (!r.ok) throw new Error(`git rev-parse HEAD failed: ${r.error}`);
  return r.out.trim();
}

/** Why the patch cannot apply cleanly to the current tree, or null when it can. */
export function checkPatch(root: string, diff: string): string | null {
  const r = git(root, ['apply', '--check', '--whitespace=nowarn', '-'], diff);
  return r.ok ? null : r.error;
}

/** Files among `files` that already carry uncommitted changes. */
export function dirtyFiles(root: string, files: string[]): string[] {
  const r = git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...files]);
  if (!r.ok) throw new Error(`git status failed: ${r.error}`);
  return lines(r.out).map((line) => line.slice(3));
}

/** Files git would ignore — `.env`, `data/`, `logs/` and the like never reach a commit. */
export function ignoredFiles(root: string, files: string[]): string[] {
  const r = git(root, ['check-ignore', '--no-index', '--', ...files]);
  return r.ok ? lines(r.out) : []; // exit 1 means nothing is ignored
}

/**
 * Apply the patch and commit exactly its files. On a failed commit the
 * working-tree change is backed out again, so a refusal leaves no trace.
 */
export function applyAndCommit(root: string, diff: string, files: string[], commitMessage: string): GitResult {
  const applied = git(root, ['apply', '--whitespace=nowarn', '-'], diff);
  if (!applied.ok) return { ok: false, error: `git apply failed: ${applied.error}` };

  const added = git(root, ['add', '--', ...files]);
  const committed = added.ok
    ? git(root, [...IDENTITY, 'commit', '--no-verify', '-m', commitMessage, '--', ...files])
    : added;
  if (committed.ok) return { ok: true, sha: head(root) };

  git(root, ['reset', '-q', '--', ...files]);
  const backedOut = git(root, ['apply', '-R', '--whitespace=nowarn', '-'], diff);
  if (!backedOut.ok) {
    return {
      ok: false,
      error: `commit failed (${committed.error}) and backing the patch out failed (${backedOut.error})`,
    };
  }
  return { ok: false, error: `commit failed: ${committed.error}` };
}

/**
 * Undo `sha` with a new commit that reverses exactly its files. Plain
 * `git revert` refuses while anything else is staged; this path leaves
 * other staged or unstaged work alone. A reverse patch that no longer
 * applies (the files moved on since) is reported, never forced.
 */
export function revert(root: string, sha: string): GitResult {
  const changed = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
  const subject = git(root, ['log', '-1', '--format=%s', sha]);
  const patch = git(root, ['diff', '--binary', `${sha}~1`, sha]);
  if (!changed.ok || !subject.ok || !patch.ok) return { ok: false, error: `cannot read ${sha}` };
  const files = lines(changed.out);

  const reversed = git(root, ['apply', '-R', '--whitespace=nowarn', '-'], patch.out);
  if (!reversed.ok) return { ok: false, error: reversed.error };
  const message = `Revert "${subject.out.trim()}"\n\nThis reverts commit ${sha}.`;
  const added = git(root, ['add', '--', ...files]);
  const committed = added.ok ? git(root, [...IDENTITY, 'commit', '--no-verify', '-m', message, '--', ...files]) : added;
  if (committed.ok) return { ok: true, sha: head(root) };

  git(root, ['reset', '-q', '--', ...files]);
  git(root, ['apply', '--whitespace=nowarn', '-'], patch.out);
  return { ok: false, error: committed.error };
}
