/**
 * The diff view — what changed in the coding session's working tree.
 *
 * Collected INSIDE the session container, through the driver's exec
 * (SessionHandle.execSpec, the same path attach and the interrupt use), as
 * the container's own user. The working tree is the agent's: a repository
 * it controls can name an external diff driver, a textconv filter, a
 * fsmonitor hook — programs git runs on the tree's behalf. Host git never
 * touches that tree; git runs where the agent already runs, with the
 * repository's helpers switched off (`--no-ext-diff --no-textconv`, an
 * empty `core.fsmonitor`) so the view is a read of the files, and its
 * output crosses to the host as bounded bytes. A session whose container
 * is not running has no diff: nothing on the host stands in for it.
 *
 * What the view shows: `git diff HEAD` for tracked changes (staged and
 * unstaged together), plus a `--no-index` diff against /dev/null for each
 * untracked file so a brand-new file shows up as the "new file" hunk it is,
 * instead of vanishing from a view whose whole point is to show new work. A
 * repository with no commit yet falls back to the index diff. Not a git
 * repository → null, and the caller sends nothing. Three outcomes are kept
 * apart for the caller (DiffCollection): a cold session (nothing to read),
 * a read that answered (hunks, a clean tree, or no repository), and a read
 * that FAILED (the exec threw, git exited with an error) — the last one is
 * retried by the runtime, never mistaken for a clean tree.
 *
 * Bounded three times: the exec's output at `execMaxBytes` (cut, marked),
 * at most `maxUntrackedFiles` new files, and `maxBytes` of view in total
 * (cut at a line boundary with a trailer that says so). Every exec has a
 * timeout.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { SessionExecSpec, SessionHandle } from '../../drivers/types.js';
import { CODE_WORKSPACE_DIR } from '../compose.js';
import { findLiveSandboxHandle } from './stop.js';

const execFileAsync = promisify(execFile);

export interface DiffView {
  content: string;
  truncated: boolean;
  headBranch?: string;
}

/** A read of the tree that did not answer: the exec failed or git exited with an error. */
export class DiffCollectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DiffCollectError';
  }
}

export interface DiffExecResult {
  stdout: string;
  code: number;
  /** The output hit the exec's byte cap and was cut. */
  truncated?: boolean;
}

/** Run one command in the session; resolves stdout with the exit code, never rejects for a non-zero exit. */
export type DiffExec = (spec: SessionExecSpec) => Promise<DiffExecResult>;

export interface CollectDiffOptions {
  maxBytes?: number;
  maxUntrackedFiles?: number;
  /** Byte cap on one exec's stdout. */
  execMaxBytes?: number;
  /** Time cap on one exec. */
  execTimeoutMs?: number;
  /** The working tree inside the session. */
  workspaceDir?: string;
  /** Test seam: run one exec spec. */
  run?: DiffExec;
}

export const DEFAULT_DIFF_MAX_BYTES = 200 * 1024;
export const DEFAULT_MAX_UNTRACKED_FILES = 40;
export const DEFAULT_DIFF_EXEC_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_DIFF_EXEC_TIMEOUT_MS = 30_000;
export const DIFF_TRUNCATED_TRAILER = '\n... (diff truncated)\n';
export const DIFF_OUTPUT_CUT_MARKER = '\n... (output cut at the exec byte cap)\n';

/**
 * The git invocation prefix for every read of the tree: run in the
 * workspace, no pager, no fsmonitor hook. The diff flags below keep the
 * repository's external diff driver and textconv filters out of it.
 */
export function gitReadArgv(workspaceDir: string, ...args: string[]): string[] {
  return ['git', '-C', workspaceDir, '-c', 'core.fsmonitor=', '--no-pager', ...args];
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv'];

/**
 * The default exec: the driver's plain argv, its stdout captured up to the
 * byte cap. Node's execFile fails the call at maxBuffer with the bytes it
 * has; that is the cut, reported as such rather than as a failure.
 */
export function defaultDiffExec(options: { maxBytes: number; timeoutMs: number }): DiffExec {
  return async (spec) => {
    try {
      const { stdout } = await execFileAsync(spec.bin, spec.argsPlain, {
        maxBuffer: options.maxBytes,
        timeout: options.timeoutMs,
        encoding: 'utf8',
      });
      return { stdout, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; code?: number | string; killed?: boolean };
      const stdout = typeof failed.stdout === 'string' ? failed.stdout : '';
      if (failed.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { stdout, code: 0, truncated: true };
      if (failed.killed) throw new Error(`diff exec timed out after ${options.timeoutMs} ms`, { cause: error });
      return { stdout, code: typeof failed.code === 'number' ? failed.code : 1 };
    }
  };
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

/** Untracked paths and the branch head out of `status --porcelain=v2 --branch -z`. */
export function parseStatus(stdout: string): { untracked: string[]; headBranch?: string } {
  const untracked: string[] = [];
  let headBranch: string | undefined;
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    if (entry.startsWith('# branch.head ')) {
      const head = entry.slice('# branch.head '.length);
      if (head && head !== '(detached)') headBranch = head;
    } else if (entry.startsWith('? ')) {
      untracked.push(entry.slice(2));
    } else if (entry.startsWith('2 ')) {
      i++; // a rename carries its original path as the next field
    }
  }
  return { untracked, headBranch };
}

/**
 * Collect the view through the live session `handle`. The exec runs the
 * driver's plain (non-tty) argv for each git read. Resolves null for a
 * workspace that is not a repository; throws DiffCollectError when a read
 * failed (an exec that threw, or git exiting with an error that is not
 * "not a repository").
 */
export async function collectDiff(handle: SessionHandle, options: CollectDiffOptions = {}): Promise<DiffView | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
  const maxUntracked = options.maxUntrackedFiles ?? DEFAULT_MAX_UNTRACKED_FILES;
  const workspaceDir = options.workspaceDir ?? CODE_WORKSPACE_DIR;
  const run =
    options.run ??
    defaultDiffExec({
      maxBytes: options.execMaxBytes ?? DEFAULT_DIFF_EXEC_MAX_BYTES,
      timeoutMs: options.execTimeoutMs ?? DEFAULT_DIFF_EXEC_TIMEOUT_MS,
    });
  const exec = async (command: string[]): Promise<DiffExecResult> => {
    try {
      return await run(handle.execSpec(command));
    } catch (error) {
      throw new DiffCollectError(`diff exec failed: ${command.slice(0, 2).join(' ')}`, { cause: error });
    }
  };
  const git = (...args: string[]) => exec(gitReadArgv(workspaceDir, ...args));
  let cut = false;
  const take = (result: DiffExecResult): string => {
    if (result.truncated) cut = true;
    return result.truncated ? result.stdout + DIFF_OUTPUT_CUT_MARKER : result.stdout;
  };

  // One read answers three questions: is this a repository (git's exit 128
  // says no), which files are untracked, and what the head branch is. Any
  // other failure is a read that did not answer.
  const status = await git('status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all');
  if (status.code === 128) return null;
  if (status.code !== 0) throw new DiffCollectError(`git status exited ${status.code}`);
  const { untracked, headBranch } = parseStatus(status.stdout);

  let tracked = await git('diff', ...DIFF_FLAGS, 'HEAD', '--');
  if (tracked.code !== 0) tracked = await git('diff', ...DIFF_FLAGS, '--'); // no HEAD yet: unstaged only
  if (tracked.code !== 0) throw new DiffCollectError(`git diff exited ${tracked.code}`);
  const parts: string[] = tracked.stdout ? [take(tracked)] : [];

  const files = untracked.slice(0, maxUntracked);
  if (files.length > 0 && !cut && parts.reduce((n, p) => n + Buffer.byteLength(p, 'utf8'), 0) <= maxBytes) {
    // One exec for every new file: the loop runs in the session, the paths
    // travel as positional arguments, never through a shell word.
    const loop = `for f in "$@"; do ${gitReadArgv(workspaceDir, 'diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null')
      .map(shQuote)
      .join(' ')} "$f"; done; exit 0`;
    const added = await exec(['sh', '-c', loop, 'sh', ...files]);
    if (added.code === 0 && added.stdout) parts.push(take(added));
  }

  const bounded = boundDiff(parts.join(''), maxBytes);
  return {
    content: bounded.content,
    truncated: bounded.truncated || cut,
    ...(headBranch ? { headBranch } : {}),
  };
}

function shQuote(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** The outcome of one read of the tree, for a running session. */
export type DiffCollection =
  /** The read answered: hunks, a clean tree (empty content), or no repository (null). */
  | { ok: true; view: DiffView | null }
  /** The read failed — retry later; this is not a clean tree. */
  | { ok: false; error: unknown };

export type SandboxDiff =
  /** No running session to read from. */
  { live: false } | ({ live: true } & DiffCollection);

export interface CollectSandboxDiffDeps extends CollectDiffOptions {
  findLiveHandle?: (agentGroupId: string) => Promise<SessionHandle | undefined>;
}

/**
 * The view for a group's coding session: through its live container, or
 * nothing when it is cold. The host never reads the tree itself.
 */
export async function collectSandboxDiff(
  agentGroupId: string,
  deps: CollectSandboxDiffDeps = {},
): Promise<SandboxDiff> {
  const { findLiveHandle, ...options } = deps;
  const handle = await (findLiveHandle ?? findLiveSandboxHandle)(agentGroupId);
  if (!handle) return { live: false };
  try {
    return { live: true, ok: true, view: await collectDiff(handle, options) };
  } catch (error) {
    return { live: true, ok: false, error };
  }
}
