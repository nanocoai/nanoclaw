/**
 * killOrphanedProcesses must match the install folder literally. A real
 * stand-in process carries `<folder>/dist/index.js` in its command line, and
 * the folder name holds a quote and regex characters.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { killOrphanedProcesses } from './service.js';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function standIn(projectRoot: string, suffix = ''): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', path.join(projectRoot, 'dist/index.js') + suffix],
    {
      stdio: 'ignore',
    },
  );
  children.push(child);
  return child;
}

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe('killOrphanedProcesses', () => {
  it('stops a stray host under a folder named with a quote and regex characters', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphans-Dan's (nano)claw+"));
    roots.push(root);
    const child = standIn(root);
    await new Promise((resolve) => setTimeout(resolve, 200));

    killOrphanedProcesses(root);

    expect(await exited(child, 2000)).toBe(true);
  });

  it('leaves a host under a look-alike folder alone (a.c is not abc)', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'orphans-'));
    roots.push(parent);
    const child = standIn(path.join(parent, 'abc'));
    await new Promise((resolve) => setTimeout(resolve, 200));

    killOrphanedProcesses(path.join(parent, 'a.c'));

    expect(await exited(child, 500)).toBe(false);
  });

  it('leaves a host under a longer path that ends with this folder alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphans-Dan's (nano)claw+"));
    roots.push(root);
    const host = standIn(root);
    const other = standIn(path.join(os.tmpdir(), 'backup', root));
    await new Promise((resolve) => setTimeout(resolve, 200));

    killOrphanedProcesses(root);

    expect(await exited(host, 2000)).toBe(true);
    expect(await exited(other, 500)).toBe(false);
  });

  it('leaves a process that names dist/index.js.map alone', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphans-Dan's (nano)claw+"));
    roots.push(root);
    const host = standIn(root);
    const other = standIn(root, '.map');
    await new Promise((resolve) => setTimeout(resolve, 200));

    killOrphanedProcesses(root);

    expect(await exited(host, 2000)).toBe(true);
    expect(await exited(other, 500)).toBe(false);
  });
});
