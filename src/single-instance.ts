/**
 * Single-instance host lock.
 *
 * Held for the lifetime of a NanoClaw host process via a PID file at
 * `data/host.lock`. Acquired before DB open, migrations, and adapter setup —
 * so a duplicate process aborts before it can race for cli.sock, the
 * Telegram bot polling session, or the per-session DBs.
 *
 * The bug this fixes: nothing in the host process previously enforced
 * singleton-ness. The CLI socket adapter unlinks-and-rebinds on startup
 * (so a second instance silently steals the socket from the first), the
 * webhook port collision is avoidable via env-var divergence, SQLite WAL
 * tolerates concurrent writers, and the systemd unit has no PIDFile=. A
 * `pnpm dev` started under a login shell could therefore run alongside a
 * systemd-managed host and race it on every outbound delivery — see the
 * post-mortem in PR #2167's sibling investigation.
 *
 * This is an advisory lock — `O_EXCL` create on a regular file. Sufficient
 * on local filesystems (NFS not supported, but NanoClaw's data dir is
 * always local). On EEXIST we read the holder PID and check liveness via
 * `kill(pid, 0)`. If the holder is dead, we reclaim; if alive, we throw a
 * `SingleInstanceError` carrying the live PID so the caller can log it
 * before exiting.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

const LOCK_FILENAME = 'host.lock';

/** Maximum stale-cleanup retries — bounds worst-case loop if two processes
 *  race on reclaim. Each iteration is one stat/read/unlink, so 5 is plenty. */
const MAX_RECLAIM_ATTEMPTS = 5;

export class SingleInstanceError extends Error {
  constructor(
    public readonly holderPid: number,
    public readonly lockFile: string,
  ) {
    super(
      `Another NanoClaw host is already running (pid ${holderPid}). ` +
        `Lock file: ${lockFile}. If that process is gone, remove the file manually.`,
    );
    this.name = 'SingleInstanceError';
  }
}

/** Probe liveness via signal 0. ESRCH = not running; EPERM = exists but
 *  owned by another user (still alive); anything else, assume alive to err
 *  on the side of refusing to start. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readHolderPid(lockFile: string): number | null {
  try {
    const text = fs.readFileSync(lockFile, 'utf8').trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface SingleInstanceHandle {
  /** Path to the lock file held by this process. */
  readonly lockFile: string;
  /** Best-effort release. Idempotent. Logs nothing — let the caller decide. */
  release(): void;
}

/**
 * Acquire the host lock. Throws `SingleInstanceError` if another live
 * process holds it. A stale lock (holder is gone) is reclaimed
 * automatically.
 *
 * Override the data directory via `dataDir` for tests.
 */
export function acquireSingleInstanceLock(dataDir: string = DATA_DIR): SingleInstanceHandle {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, LOCK_FILENAME);

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
    try {
      // 'wx' = O_WRONLY | O_CREAT | O_EXCL — atomic create-or-fail.
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return makeHandle(lockFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    // EEXIST — someone holds it (or it's stale). Check.
    const holderPid = readHolderPid(lockFile);
    if (holderPid !== null && isProcessAlive(holderPid)) {
      throw new SingleInstanceError(holderPid, lockFile);
    }

    // Stale (or unreadable garbage). Try to remove it. ENOENT means another
    // process beat us to the cleanup — loop and retry the create.
    try {
      fs.unlinkSync(lockFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Should be unreachable under normal contention. If we get here, two
  // processes are aggressively racing reclaim — surface as if the other
  // wins, so this one exits.
  const holderPid = readHolderPid(lockFile) ?? 0;
  throw new SingleInstanceError(holderPid, lockFile);
}

function makeHandle(lockFile: string): SingleInstanceHandle {
  let released = false;
  return {
    lockFile,
    release(): void {
      if (released) return;
      released = true;
      try {
        // Re-check ownership before unlinking — a stale-reclaim from another
        // process could have replaced our file with theirs. If the PID
        // doesn't match, the lock isn't ours anymore; leave it alone.
        const holderPid = readHolderPid(lockFile);
        if (holderPid === process.pid) {
          fs.unlinkSync(lockFile);
        }
      } catch {
        // Best-effort. A failed release just leaves a stale file that the
        // next start will reclaim.
      }
    },
  };
}
