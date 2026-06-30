import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureManagedDirectory } from './safe-managed-path.js';

const tmpRoots: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-managed-path-'));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ensureManagedDirectory', () => {
  it('creates a missing managed directory under its parent', () => {
    const root = tmpDir();
    const child = path.join(root, 'managed');

    ensureManagedDirectory(root, child, 'managed test directory');

    expect(fs.statSync(child).isDirectory()).toBe(true);
  });

  it('rejects symlinked managed directories without touching the target', () => {
    const root = tmpDir();
    const outside = tmpDir();
    const victim = path.join(outside, 'mount-allowlist.json');
    fs.writeFileSync(victim, 'keep me');
    fs.symlinkSync(outside, path.join(root, 'managed'), 'dir');

    expect(() => ensureManagedDirectory(root, path.join(root, 'managed'), 'managed test directory')).toThrow(
      /not a symlink/,
    );

    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
  });

  it('rejects child paths that escape the managed parent', () => {
    const root = tmpDir();
    const outside = tmpDir();

    expect(() => ensureManagedDirectory(root, outside, 'managed test directory')).toThrow(/must be inside/);
  });
});
