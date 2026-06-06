import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tryAcquireLock } from './single-instance.js';

describe('tryAcquireLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-lock-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('claims a clean directory and records our pid', () => {
    const res = tryAcquireLock(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fs.readFileSync(res.lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('refuses when a LIVE process already holds the lock', () => {
    // pid 1 (launchd/init) is always alive and is not us.
    fs.writeFileSync(path.join(dir, 'nanoclaw.lock'), '1');
    const res = tryAcquireLock(dir);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.holderPid).toBe(1);
    expect(res.holderInfo).toBeTruthy();
  });

  it('reclaims a STALE lock left by a dead process', () => {
    // A very high pid that is essentially guaranteed not to exist.
    fs.writeFileSync(path.join(dir, 'nanoclaw.lock'), '2147483646');
    const res = tryAcquireLock(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fs.readFileSync(res.lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a garbage / empty lock file', () => {
    fs.writeFileSync(path.join(dir, 'nanoclaw.lock'), 'not-a-pid');
    const res = tryAcquireLock(dir);
    expect(res.ok).toBe(true);
  });
});
