import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { withWorkspaceDirectoryLock } from './workspace-materializer-lock.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('serializes materializers with atomic directory creation', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'workspace-materializer-lock-'));
  const lock = path.join(root, 'lock');
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = withWorkspaceDirectoryLock(lock, async () => { order.push('first-start'); await held; order.push('first-end'); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = withWorkspaceDirectoryLock(lock, async () => { order.push('second'); });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(order).toEqual(['first-start']);
  release();
  await Promise.all([first, second]);
  expect(order).toEqual(['first-start', 'first-end', 'second']);
});
