import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/**
 * Single-instance guard for the host process.
 *
 * Two concurrent host processes each run the 60s sweep and independently spawn a
 * container for the same due message — the only spawn-idempotency check
 * (`activeContainers` in container-runner) is per-process in-memory, so each host has
 * its own empty map and both spawn. The agent then generates and delivers the same
 * scheduled nudge twice (the duplicate-message bug). Nothing else stops a second
 * `node dist/index.js` / `pnpm run dev`: the unix sockets are unlink-and-rebind
 * (stolen, not contended) and the only EADDRINUSE-fatal bind (the webhook port) is
 * dormant on a Telegram-polling install. This lock makes a second host refuse to start.
 *
 * Mechanism: an O_EXCL pidfile at <dataDir>/nanoclaw.lock. A stale lock (holder process
 * gone) is reclaimed; a live holder is fatal. The pidfile is removed on clean exit; a
 * SIGKILL leaves it behind, but the next start's liveness check reclaims the dead pid.
 */

const LOCK_FILE = 'nanoclaw.lock';

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but is owned by another user → still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function describeProcess(pid: number): string {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,command='], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return `pid ${pid} (ps lookup failed)`;
  }
}

export type LockResult =
  | { ok: true; lockPath: string }
  | { ok: false; holderPid: number; holderInfo: string; lockPath: string };

/**
 * Pure, testable core: try to claim the lock. Never touches the process lifecycle.
 * Returns ok:true having written our pid, or ok:false with the live holder's details.
 */
export function tryAcquireLock(dataDir: string): LockResult {
  const lockPath = path.join(dataDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_CREAT|O_EXCL|O_WRONLY — throws EEXIST if present
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true, lockPath };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holderPid = 0;
      try {
        holderPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10) || 0;
      } catch {
        holderPid = 0;
      }
      if (holderPid !== process.pid && processAlive(holderPid)) {
        return { ok: false, holderPid, holderInfo: describeProcess(holderPid), lockPath };
      }
      // Stale lock (holder gone, or it is our own pid) → remove and retry once.
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* raced with another reclaimer — retry will resolve */
      }
    }
  }
  // Lost a reclaim race twice — treat as held rather than risk two hosts.
  return { ok: false, holderPid: 0, holderInfo: 'unknown (lock contention)', lockPath };
}

/**
 * Acquire the single-instance lock or exit(1). On success, registers an exit hook to
 * remove the pidfile. Call this at the very top of main(), before any sweep/poll/socket
 * starts.
 */
export function acquireSingleInstanceLock(dataDir: string): void {
  const res = tryAcquireLock(dataDir);
  if (!res.ok) {
    log.fatal(
      `Another NanoClaw host is already running (pid ${res.holderPid}) — refusing to start a ` +
        `second host. Two hosts double-spawn containers and produce duplicate messages. Stop the ` +
        `other instance first, then retry. Holder: ${res.holderInfo}`,
    );
    process.exit(1);
  }
  const cleanup = (): void => {
    try {
      if (fs.readFileSync(res.lockPath, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(res.lockPath);
      }
    } catch {
      /* already gone / not ours — nothing to do */
    }
  };
  process.once('exit', cleanup);
  log.info('Single-instance lock acquired', { lockPath: res.lockPath, pid: process.pid });
}
