/**
 * The diff view — what changed in the coding session's working tree.
 *
 * Runs host-side against the session's workspace dir (the container's
 * /workspace/group is `<sessDir>/group` on the host, container-runner.ts).
 * Nothing is written to the repository: `git diff HEAD` for tracked changes
 * (staged and unstaged together), plus a `--no-index` diff against
 * /dev/null for each untracked file so a brand-new file shows up as the
 * "new file" hunk it is, instead of vanishing from a view whose whole point
 * is to show new work. Untracked binaries are skipped; a repository with no
 * commit yet falls back to the index diff.
 *
 * Bounded twice: at most `maxUntrackedFiles` new files, and `maxBytes` of
 * output in total (cut at a line boundary with a trailer that says so).
 * `safe.directory=*` because the tree may be owned by the container's uid.
 * Not a git repository → null, and the caller sends nothing.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DiffView {
  content: string;
  truncated: boolean;
  headBranch?: string;
}

export interface CollectDiffOptions {
  maxBytes?: number;
  maxUntrackedFiles?: number;
  /** Test seam: run one git invocation; resolves stdout, rejects with the exit code attached. */
  run?: (args: string[]) => Promise<{ stdout: string; code: number }>;
}

export const DEFAULT_DIFF_MAX_BYTES = 200 * 1024;
export const DEFAULT_MAX_UNTRACKED_FILES = 40;
export const DIFF_TRUNCATED_TRAILER = '\n... (diff truncated)\n';

async function defaultRun(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync('git', args, { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    return { stdout, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; code?: number | string };
    return { stdout: typeof failed.stdout === 'string' ? failed.stdout : '', code: Number(failed.code) || 1 };
  }
}

/** Cut at `maxBytes` on a line boundary and say so. */
export function boundDiff(content: string, maxBytes: number): { content: string; truncated: boolean } {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return { content, truncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(DIFF_TRUNCATED_TRAILER, 'utf8'));
  let cut = Buffer.from(content, 'utf8').subarray(0, budget).toString('utf8');
  // Drop a partially decoded last character and end on a whole line.
  cut = cut.replace(/�$/, '');
  const lastNewline = cut.lastIndexOf('\n');
  if (lastNewline > 0) cut = cut.slice(0, lastNewline + 1);
  return { content: cut + DIFF_TRUNCATED_TRAILER, truncated: true };
}

export async function collectDiff(repoDir: string, options: CollectDiffOptions = {}): Promise<DiffView | null> {
  const run = options.run ?? defaultRun;
  const maxBytes = options.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const maxUntracked = options.maxUntrackedFiles ?? DEFAULT_MAX_UNTRACKED_FILES;
  const git = (...args: string[]) => run(['-c', 'safe.directory=*', '-C', repoDir, ...args]);

  const inside = await git('rev-parse', '--is-inside-work-tree');
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;

  let tracked = await git('diff', '--no-color', 'HEAD', '--');
  if (tracked.code !== 0) tracked = await git('diff', '--no-color', '--'); // no HEAD yet: unstaged only
  const parts: string[] = tracked.code === 0 && tracked.stdout ? [tracked.stdout] : [];

  const untracked = await git('ls-files', '--others', '--exclude-standard', '-z');
  if (untracked.code === 0) {
    const files = untracked.stdout.split('\0').filter(Boolean).slice(0, maxUntracked);
    let bytes = parts.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0);
    for (const file of files) {
      if (bytes > maxBytes) break;
      // --no-index exits 1 when the files differ, which is the expected case.
      const added = await git('diff', '--no-color', '--no-index', '--', '/dev/null', file);
      if (added.code > 1 || !added.stdout) continue;
      parts.push(added.stdout);
      bytes += Buffer.byteLength(added.stdout, 'utf8');
    }
  }

  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const headBranch =
    branch.code === 0 && branch.stdout.trim() && branch.stdout.trim() !== 'HEAD' ? branch.stdout.trim() : undefined;

  const bounded = boundDiff(parts.join(''), maxBytes);
  return { ...bounded, ...(headBranch ? { headBranch } : {}) };
}
