/**
 * The group folder is mounted read-write into the container, so the container
 * owns the `tasks` dir and each `<series>.md`. Appends and deletes of a run log
 * must stay inside the group folder whatever the container turns those into.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-test-run-log';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-run-log/groups' };
});
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async () => ({ id: 'ag', folder: 'grp', name: 'G' })),
}));
vi.mock('../../container-config.js', () => ({ resolveGroupTimezone: vi.fn(async () => 'UTC') }));
vi.mock('../../timezone.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../timezone.js')>()),
  formatLocalStamp: vi.fn(() => 'TS'),
}));

import { appendRunLog, deleteRunLog, readRunLogTail } from './run-log.js';

const GROUP_DIR = path.join(TEST_ROOT, 'groups', 'grp');

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(GROUP_DIR, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('run log happy path', () => {
  it('appends lines to tasks/<series>.md and deletes it', async () => {
    const res = await appendRunLog('ag', 'daily-digest', 'started');
    await appendRunLog('ag', 'daily-digest', 'done');
    const file = path.join(GROUP_DIR, 'tasks', 'daily-digest.md');
    expect(res.path).toBe(file);
    expect(fs.readFileSync(file, 'utf-8')).toBe('TS — started\nTS — done\n');

    expect(await readRunLogTail('ag', 'daily-digest')).toEqual(['TS — started', 'TS — done']);

    await deleteRunLog('ag', 'daily-digest');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('run log symlink containment', () => {
  it('appends nothing through a symlinked tasks dir', async () => {
    const hostDir = path.join(TEST_ROOT, 'host-outside');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.symlinkSync(hostDir, path.join(GROUP_DIR, 'tasks'));

    await expect(appendRunLog('ag', 'evil', 'x')).rejects.toThrow();

    expect(fs.existsSync(path.join(hostDir, 'evil.md'))).toBe(false);
  });

  it('appends nothing through a symlinked <series>.md leaf', async () => {
    const target = path.join(TEST_ROOT, 'host-target.md');
    fs.writeFileSync(target, 'original');
    fs.mkdirSync(path.join(GROUP_DIR, 'tasks'), { recursive: true });
    fs.symlinkSync(target, path.join(GROUP_DIR, 'tasks', 'evil.md'));

    await expect(appendRunLog('ag', 'evil', 'x')).rejects.toThrow();

    expect(fs.readFileSync(target, 'utf-8')).toBe('original');
  });

  it('reads nothing through a symlinked tasks dir', async () => {
    const hostDir = path.join(TEST_ROOT, 'host-read');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'evil.md'), 'host-secret');
    fs.symlinkSync(hostDir, path.join(GROUP_DIR, 'tasks'));

    expect(await readRunLogTail('ag', 'evil')).toEqual([]);
  });

  it('reads nothing through a symlinked <series>.md leaf', async () => {
    const target = path.join(TEST_ROOT, 'host-secret.md');
    fs.writeFileSync(target, 'host-secret');
    fs.mkdirSync(path.join(GROUP_DIR, 'tasks'), { recursive: true });
    fs.symlinkSync(target, path.join(GROUP_DIR, 'tasks', 'evil.md'));

    expect(await readRunLogTail('ag', 'evil')).toEqual([]);
  });

  it('does not block or write when the leaf is a FIFO', async () => {
    fs.mkdirSync(path.join(GROUP_DIR, 'tasks'), { recursive: true });
    execFileSync('mkfifo', [path.join(GROUP_DIR, 'tasks', 'evil.md')]);

    // Must reject promptly (no reader → would hang without O_NONBLOCK), not stall.
    await expect(appendRunLog('ag', 'evil', 'x')).rejects.toThrow();
  });

  it('deletes nothing through a symlinked tasks dir', async () => {
    const hostDir = path.join(TEST_ROOT, 'host-del');
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(path.join(hostDir, 'evil.md'), 'keep');
    fs.symlinkSync(hostDir, path.join(GROUP_DIR, 'tasks'));

    await deleteRunLog('ag', 'evil'); // best-effort: must not throw, must not follow

    expect(fs.readFileSync(path.join(hostDir, 'evil.md'), 'utf-8')).toBe('keep');
  });
});
