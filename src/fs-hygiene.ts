/**
 * File helpers for paths the host shares with agent containers.
 *
 * Parts of the tree the host reads and writes are also mounted into agent
 * containers: the group folder (`/workspace/agent`), the per-group Claude
 * state dir (`/home/node/.claude`), and the session folder (`/workspace`).
 * Entries there can already exist, and can exist as something other than the
 * regular file a caller expects, because more than one party puts things in
 * those directories.
 *
 * For that situation the `fs` defaults are the wrong defaults: `readFileSync`
 * resolves the name and reads whatever it lands on, and `writeFileSync`
 * resolves the name and truncates whatever it lands on. Neither is a decision
 * an individual call site should be making in passing, so the two conservative
 * forms live here and get used by name:
 *
 *   - {@link readTextNoFollow} — read the name we were given.
 *   - {@link writeTextAtomic}  — stage under a fresh name, publish by rename,
 *     so the destination is replaced as a unit rather than written into.
 *   - {@link writeTextIfAbsent} — claim a name, in one syscall, or report that
 *     someone else already holds it.
 *
 * All three concern the final path component. Where the parent directories
 * live and who may write them is settled by the mount table (`buildMounts`),
 * not here — no check in this file could establish it, since every syscall
 * resolves the whole path afresh.
 *
 * `src/group-persona.ts` already carried the first two inline; these are the
 * same moves, named, so the next accessor can reach for them.
 */
import crypto from 'crypto';
import fs from 'fs';

import { log } from './log.js';

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/**
 * Read a UTF-8 text file, resolving nothing beyond the name given.
 *
 * Returns `null` when the file is absent, is not a regular file, or cannot be
 * read — matching how these call sites already treat an unreadable optional
 * file.
 */
export function readTextNoFollow(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf-8');
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') {
      log.warn('Not a regular file; skipping', { file });
      return null;
    }
    log.warn('Could not read file', { file, error: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Write `content` to `file` via a freshly-created temporary sibling and a
 * rename, so readers see the old file or the new one and never a partial one.
 *
 * The staging name is random rather than derived from the pid: a pid is stable
 * for the life of the host process, and a staging name that can be predicted
 * is a staging name that can already be occupied when we go to use it.
 */
export function writeTextAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx' });
    fs.renameSync(tmp, file);
    // `rename(2)` moves the final component without resolving it, so what
    // lands at `file` is whatever `tmp` was at that moment — and `tmp` shares
    // a directory with whoever else writes there. An exclusive create makes
    // the name ours when we take it; it does not keep it ours afterwards.
    // Publishing anything other than the regular file we just wrote is a
    // failure, not a result: undo it and say so.
    const published = fs.lstatSync(file);
    if (!published.isFile()) {
      fs.unlinkSync(file);
      throw new Error(`refusing to publish ${file}: staged entry was replaced before rename`);
    }
  } finally {
    // The rename consumed it on the happy path; this clears the residue when
    // the write succeeded but the rename did not.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already renamed away, or never created */
    }
  }
}

/**
 * Create `file` with `content` only if the name is free.
 *
 * Returns `true` when this call created it, `false` when something was already
 * there. The test and the creation are one syscall, so the answer describes
 * the name itself and cannot go stale between deciding and acting.
 */
export function writeTextIfAbsent(file: string, content: string): boolean {
  try {
    fs.writeFileSync(file, content, { flag: 'wx' });
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    throw err;
  }
}
