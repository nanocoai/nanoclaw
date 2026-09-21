import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isErrno } from './errors.js';

/**
 * One-owner lock files for the setup journal, the checkout mutation lock and
 * the Slack install worker. The file holds its owner as JSON so a peer can
 * tell a live owner from a crashed one; `started` is a per-boot process birth
 * identity, so a reused PID after a reboot is not mistaken for the owner.
 *
 * Claims use link(2), which is atomic and fails when the file exists, so a
 * reader never sees a half-written owner. Reclaiming a dead owner removes the
 * file only if it is still the inode that was inspected.
 */
export interface LockOwner {
  pid: number;
  nonce: string;
  started: string;
}

export function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `${boot}:${status.slice(status.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined
    );
  } catch (_error) {
    return undefined;
  }
}

function ownerAlive(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    // EPERM: the process exists but belongs to another user.
  }
  const current = processIdentity(owner.pid);
  return !current || !owner.started || current === owner.started;
}

function readOwner(file: string): LockOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { pid, nonce = '', started = '' } = parsed as Partial<LockOwner>;
    return typeof pid === 'number' ? { pid, nonce: String(nonce), started: String(started) } : undefined;
  } catch (_error) {
    return undefined;
  }
}

async function inode(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).ino;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/** The live owner of `file`, or undefined when the lock is free or its owner is gone. */
export function processLockOwner(file: string): LockOwner | undefined {
  const owner = readOwner(file);
  return owner && ownerAlive(owner) ? owner : undefined;
}

/**
 * Claim `file` for this process. Resolves to a release function, or null while
 * another live process holds it. The lock is released on process exit as well.
 */
export async function processLock(file: string): Promise<(() => void) | null> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID(), started: processIdentity(process.pid) || '' };
  const staged = `${file}.${owner.nonce}.tmp`;
  const handle = await open(staged, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(staged, file);
        return release(file, owner);
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error;
      }
      const seen = await inode(file);
      const current = readOwner(file);
      if (current && ownerAlive(current)) return null;
      if (seen !== undefined && seen === (await inode(file))) {
        try {
          await unlink(file);
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error;
        }
      }
    }
    return null;
  } finally {
    await unlink(staged).catch(() => undefined);
  }
}

function release(file: string, owner: LockOwner): () => void {
  let released = false;
  const run = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', run);
    try {
      const current = readOwner(file);
      if (current?.pid === owner.pid && current.nonce === owner.nonce) unlinkSync(file);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
  };
  process.once('exit', run);
  return run;
}
