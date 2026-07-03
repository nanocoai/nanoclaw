/**
 * Unit tests for the single-instance host lock.
 *
 * Each test runs in its own tmp directory to avoid cross-test interference.
 * Liveness is probed via real `process.kill(pid, 0)`, so the test that
 * simulates a dead holder uses a never-allocated PID (PID 1 is always
 * alive on Linux/macOS — `init` — so we use a definitely-dead PID instead).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireSingleInstanceLock, SingleInstanceError } from './single-instance.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-si-test-'));
}

function findDeadPid(): number {
  // Probe upward until we find one that's not running. PID 1 is always
  // alive (init), so start high and work up. Caps at 10000 attempts to
  // avoid spinning if the OS happens to be very full.
  for (let pid = 99999; pid < 99999 + 10000; pid++) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('Could not find a dead PID for the test');
}

describe('single-instance lock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('acquires the lock when no holder exists, writing the current pid', () => {
    const handle = acquireSingleInstanceLock(tmpDir);
    expect(handle.lockFile).toBe(path.join(tmpDir, 'host.lock'));
    expect(fs.existsSync(handle.lockFile)).toBe(true);
    expect(fs.readFileSync(handle.lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('release() removes the lock file when this process owns it', () => {
    const handle = acquireSingleInstanceLock(tmpDir);
    expect(fs.existsSync(handle.lockFile)).toBe(true);
    handle.release();
    expect(fs.existsSync(handle.lockFile)).toBe(false);
  });

  it('release() is idempotent — second call is a no-op', () => {
    const handle = acquireSingleInstanceLock(tmpDir);
    handle.release();
    expect(() => handle.release()).not.toThrow();
  });

  it('after release, the lock can be re-acquired in the same process', () => {
    const first = acquireSingleInstanceLock(tmpDir);
    first.release();
    const second = acquireSingleInstanceLock(tmpDir);
    expect(fs.existsSync(second.lockFile)).toBe(true);
    second.release();
  });

  it('throws SingleInstanceError when a live process holds the lock', () => {
    // Simulate a live holder by writing our own PID to the lock file
    // without acquiring through the API. process.kill(self, 0) returns true,
    // so the lock looks live to the second caller.
    const lockFile = path.join(tmpDir, 'host.lock');
    fs.writeFileSync(lockFile, String(process.pid));

    let caught: unknown;
    try {
      acquireSingleInstanceLock(tmpDir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SingleInstanceError);
    const sie = caught as SingleInstanceError;
    expect(sie.holderPid).toBe(process.pid);
    expect(sie.lockFile).toBe(lockFile);
    // File must NOT have been disturbed — still owned by the "holder".
    expect(fs.readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a stale lock whose holder PID is no longer running', () => {
    const lockFile = path.join(tmpDir, 'host.lock');
    const deadPid = findDeadPid();
    fs.writeFileSync(lockFile, String(deadPid));

    const handle = acquireSingleInstanceLock(tmpDir);
    // The reclaim path unlinks then re-creates with our PID.
    expect(fs.readFileSync(handle.lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a lock file with non-numeric garbage as content', () => {
    const lockFile = path.join(tmpDir, 'host.lock');
    fs.writeFileSync(lockFile, 'not-a-pid');

    const handle = acquireSingleInstanceLock(tmpDir);
    expect(fs.readFileSync(handle.lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a lock file with PID 0 (invalid)', () => {
    const lockFile = path.join(tmpDir, 'host.lock');
    fs.writeFileSync(lockFile, '0');

    const handle = acquireSingleInstanceLock(tmpDir);
    expect(fs.readFileSync(handle.lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a lock file with negative PID (invalid)', () => {
    const lockFile = path.join(tmpDir, 'host.lock');
    fs.writeFileSync(lockFile, '-42');

    const handle = acquireSingleInstanceLock(tmpDir);
    expect(fs.readFileSync(handle.lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('release() is a no-op when this process no longer owns the lock', () => {
    // Acquire, then have someone else "take over" by overwriting the file.
    // Our release() should detect the PID mismatch and leave the file alone.
    const handle = acquireSingleInstanceLock(tmpDir);
    fs.writeFileSync(handle.lockFile, '99999999'); // pretend another process took over
    handle.release();
    // File must still be there — we didn't own it anymore.
    expect(fs.existsSync(handle.lockFile)).toBe(true);
    expect(fs.readFileSync(handle.lockFile, 'utf8').trim()).toBe('99999999');
  });

  it('creates the data directory if it does not exist yet (fresh install)', () => {
    const fresh = path.join(tmpDir, 'nested', 'data');
    expect(fs.existsSync(fresh)).toBe(false);
    const handle = acquireSingleInstanceLock(fresh);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(handle.lockFile)).toBe(true);
  });
});
