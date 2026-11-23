import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { processIdentity, processLock, processLockOwner } from './process-lock.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function lockFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nc-lock-'));
  dirs.push(dir);
  await mkdir(path.join(dir, 'data'));
  return path.join(dir, 'data/test.lock');
}

it('claims a free lock, names its owner, and refuses a second claim until released', async () => {
  const file = await lockFile();
  const release = await processLock(file);
  expect(release).toBeTypeOf('function');
  expect(processLockOwner(file)).toMatchObject({ pid: process.pid, started: processIdentity(process.pid) ?? '' });
  expect(await processLock(file)).toBeNull();
  release!();
  expect(processLockOwner(file)).toBeUndefined();
  const again = await processLock(file);
  expect(again).toBeTypeOf('function');
  again!();
});

it('writes an owner-only file with a complete record and leaves no staging file behind', async () => {
  const file = await lockFile();
  const release = await processLock(file);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const owner = JSON.parse(await readFile(file, 'utf8'));
  expect(owner).toEqual({ pid: process.pid, nonce: expect.any(String), started: expect.any(String) });
  expect(owner.nonce).toHaveLength(36);
  expect(await readdir(path.dirname(file))).toEqual(['test.lock']);
  release!();
  expect(await readdir(path.dirname(file))).toEqual([]);
});

it('reclaims a lock whose owner process has exited', async () => {
  const file = await lockFile();
  const { pid } = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await writeFile(file, JSON.stringify({ pid, nonce: 'gone', started: 'whenever' }));
  expect(processLockOwner(file)).toBeUndefined();
  const release = await processLock(file);
  expect(release).toBeTypeOf('function');
  expect(processLockOwner(file)?.pid).toBe(process.pid);
  release!();
});

it('reclaims a lock from a previous boot even when its PID is in use again', async () => {
  const file = await lockFile();
  await writeFile(file, JSON.stringify({ pid: process.pid, nonce: 'old-owner', started: 'previous-boot' }));
  expect(processLockOwner(file)).toBeUndefined();
  const release = await processLock(file);
  expect(release).toBeTypeOf('function');
  expect(processLockOwner(file)?.nonce).not.toBe('old-owner');
  release!();
});

it('honours a live owner recorded with only a pid, and treats an unreadable record as stale', async () => {
  const file = await lockFile();
  await writeFile(file, JSON.stringify({ pid: process.pid }));
  expect(processLockOwner(file)).toMatchObject({ pid: process.pid, nonce: '', started: '' });
  expect(await processLock(file)).toBeNull();
  await writeFile(file, 'not json');
  expect(processLockOwner(file)).toBeUndefined();
  const release = await processLock(file);
  expect(release).toBeTypeOf('function');
  release!();
});

it('release removes only the record this claim wrote', async () => {
  const file = await lockFile();
  const release = await processLock(file);
  const other = { pid: process.pid, nonce: 'someone-else', started: processIdentity(process.pid) ?? '' };
  await writeFile(file, JSON.stringify(other));
  release!();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(other);
});
