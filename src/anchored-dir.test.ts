import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnchoredDir, copyRegularFile } from './anchored-dir.js';

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchored-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'anchored-outside-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function openOrThrow(segments: string[], create = false): AnchoredDir {
  const dir = AnchoredDir.open(root, segments, create);
  if (!dir) throw new Error('expected a directory');
  return dir;
}

describe('AnchoredDir.open', () => {
  it('creates missing segments when asked, returns null otherwise', () => {
    expect(AnchoredDir.open(root, ['a', 'b'])).toBeNull();
    openOrThrow(['a', 'b'], true).close();
    expect(fs.statSync(path.join(root, 'a', 'b')).isDirectory()).toBe(true);
  });

  it('refuses a symlink at any segment, even when creating', () => {
    fs.mkdirSync(path.join(root, 'a'));
    fs.symlinkSync(outside, path.join(root, 'a', 'b'));
    expect(() => AnchoredDir.open(root, ['a', 'b'])).toThrow(/not a real directory/);
    expect(() => AnchoredDir.open(root, ['a', 'b', 'c'], true)).toThrow(/not a real directory/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('follows a symlink in the host-owned root itself', () => {
    const link = path.join(outside, 'root-link');
    fs.symlinkSync(root, link);
    const dir = AnchoredDir.open(link, ['x'], true);
    dir?.close();
    expect(fs.existsSync(path.join(root, 'x'))).toBe(true);
  });

  it('rejects names that are not a single path segment', () => {
    const dir = openOrThrow([]);
    try {
      for (const name of ['..', '.', '', 'a/b', 'a\0b']) expect(() => dir.openDir(name)).toThrow(/unsafe entry name/);
    } finally {
      dir.close();
    }
  });
});

describe('operations stay on the opened directory', () => {
  it('keep working on the original after the path is swapped for a symlink', () => {
    const dir = openOrThrow(['inbox', 'msg'], true);
    try {
      fs.renameSync(path.join(root, 'inbox'), path.join(root, 'inbox-moved'));
      fs.symlinkSync(outside, path.join(root, 'inbox'));

      dir.writeNewFile('a.txt', Buffer.from('a'));
      expect(dir.readFile('a.txt').toString()).toBe('a');
      expect(dir.entries()).toEqual(['a.txt']);
      dir.unlink('a.txt');
    } finally {
      dir.close();
    }
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'inbox-moved', 'msg'))).toEqual([]);
  });

  it('writeNewFile refuses an existing entry, a symlink included', () => {
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'keep');
    const dir = openOrThrow([]);
    try {
      fs.symlinkSync(target, path.join(root, 'link.txt'));
      expect(() => dir.writeNewFile('link.txt', Buffer.from('x'))).toThrow(/EEXIST/);
      dir.writeNewFile('new.txt', Buffer.from('x'));
      expect(() => dir.writeNewFile('new.txt', Buffer.from('y'))).toThrow(/EEXIST/);
    } finally {
      dir.close();
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep');
  });

  it('readFile refuses a symlink, a directory and a FIFO without blocking', () => {
    const target = path.join(outside, 'secret.txt');
    fs.writeFileSync(target, 'secret');
    fs.symlinkSync(target, path.join(root, 'link.txt'));
    fs.mkdirSync(path.join(root, 'sub'));
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    const dir = openOrThrow([]);
    try {
      expect(() => dir.readFile('link.txt')).toThrow();
      expect(() => dir.readFile('sub')).toThrow(/not a regular file/);
      expect(() => dir.readFile('pipe')).toThrow(/not a regular file/);
      expect(() => dir.readFile('missing')).toThrow(/ENOENT/);
    } finally {
      dir.close();
    }
  });

  it('replaceFile swaps a symlinked leaf for the new content and leaves the target alone', () => {
    const target = path.join(outside, 'host.json');
    fs.writeFileSync(target, 'host');
    fs.symlinkSync(target, path.join(root, 'settings.json'));
    const dir = openOrThrow([]);
    try {
      dir.replaceFile('settings.json', 'new');
    } finally {
      dir.close();
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('host');
    expect(fs.lstatSync(path.join(root, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(root, 'settings.json'), 'utf-8')).toBe('new');
    expect(fs.readdirSync(root)).toEqual(['settings.json']);
  });

  it('replaceFile writes into the opened directory after its path is swapped for a symlink', () => {
    fs.mkdirSync(path.join(root, 'state'));
    fs.writeFileSync(path.join(root, 'state', 'settings.json'), 'old');
    const dir = openOrThrow(['state']);
    try {
      fs.renameSync(path.join(root, 'state'), path.join(root, 'moved'));
      fs.symlinkSync(outside, path.join(root, 'state'));
      dir.replaceFile('settings.json', 'new');
    } finally {
      dir.close();
    }
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'moved', 'settings.json'), 'utf-8')).toBe('new');
    expect(fs.readdirSync(path.join(root, 'moved'))).toEqual(['settings.json']);
  });

  it('replaceFile leaves a pre-existing entry under the temp name alone', () => {
    const dir = openOrThrow([]);
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      fs.writeFileSync(path.join(root, `a.txt.tmp-${process.pid}-${now}`), 'theirs');
      expect(() => dir.replaceFile('a.txt', 'mine')).toThrow(/EEXIST/);
    } finally {
      spy.mockRestore();
      dir.close();
    }
    expect(fs.readFileSync(path.join(root, `a.txt.tmp-${process.pid}-${now}`), 'utf-8')).toBe('theirs');
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(false);
  });

  it('copyRegularFile streams multi-chunk content intact and preserves mode', () => {
    const src = openOrThrow(['src'], true);
    const dst = openOrThrow(['dst'], true);
    try {
      // Larger than the 64 KiB copy buffer, so the streaming loop runs several times.
      const payload = Buffer.alloc(200 * 1024, 0x61);
      src.writeNewFile('run.sh', payload);
      fs.chmodSync(path.join(root, 'src', 'run.sh'), 0o755);

      copyRegularFile(src, 'run.sh', dst, 'run.sh');

      const copied = path.join(root, 'dst', 'run.sh');
      expect(fs.readFileSync(copied).equals(payload)).toBe(true);
      expect(fs.statSync(copied).mode & 0o777).toBe(0o755);
      // Exclusive create: a second copy onto the same name is refused.
      expect(() => copyRegularFile(src, 'run.sh', dst, 'run.sh')).toThrow(/EEXIST/);
    } finally {
      src.close();
      dst.close();
    }
  });

  it('copyRegularFile refuses a symlinked source, writing nothing', () => {
    const outsideFile = path.join(outside, 'secret');
    fs.writeFileSync(outsideFile, 'secret');
    const src = openOrThrow(['src'], true);
    const dst = openOrThrow(['dst'], true);
    try {
      fs.symlinkSync(outsideFile, path.join(root, 'src', 'link'));
      expect(() => copyRegularFile(src, 'link', dst, 'out')).toThrow();
      expect(fs.existsSync(path.join(root, 'dst', 'out'))).toBe(false);
    } finally {
      src.close();
      dst.close();
    }
  });

  it('unlink removes a symlink, never its target', () => {
    const target = path.join(outside, 'target.txt');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, path.join(root, 'link.txt'));
    const dir = openOrThrow([]);
    try {
      expect(dir.lstat('link.txt').isSymbolicLink()).toBe(true);
      dir.unlink('link.txt');
      dir.symlink('/app/skills/x', 'x');
    } finally {
      dir.close();
    }
    expect(fs.readFileSync(target, 'utf-8')).toBe('keep');
    expect(fs.readlinkSync(path.join(root, 'x'))).toBe('/app/skills/x');
  });
});
