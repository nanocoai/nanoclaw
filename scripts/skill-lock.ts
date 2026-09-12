import { createHash } from 'node:crypto';
import { closeSync, openSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function applyLockPath(root: string): string {
  const key = createHash('sha256').update(realpathSync(root)).digest('hex');
  return join(tmpdir(), `nanoclaw-skill-apply-${key}.lock`);
}

/** One writer per physical checkout, including rollback. */
export async function withApplyLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const file = applyLockPath(root);
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Never reclaim automatically: two stale-lock contenders can delete a new
    // owner's lock. After a crash the operator verifies no installer is running.
    throw new Error(`another skill apply may be running on this checkout; after verifying it has stopped, remove ${file}`);
  }
  try {
    writeSync(fd, String(process.pid));
    return await run();
  } finally {
    closeSync(fd);
    unlinkSync(file);
  }
}
