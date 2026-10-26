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
  vi.restoreAllMocks();
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

  it('recursive removal stays in the pinned directory and removes links without touching their targets', () => {
    fs.mkdirSync(path.join(root, 'parent', 'tree', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'parent', 'tree', 'nested', 'file'), 'remove');
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    fs.symlinkSync(outside, path.join(root, 'parent', 'tree', 'link'));
    fs.symlinkSync(outside, path.join(root, 'parent', 'link'));
    const dir = openOrThrow(['parent']);
    try {
      fs.renameSync(path.join(root, 'parent'), path.join(root, 'moved'));
      fs.symlinkSync(outside, path.join(root, 'parent'));
      dir.remove('tree', true);
      dir.remove('link', true);
      dir.remove('missing', true);
      expect(dir.entries()).toEqual([]);
    } finally {
      dir.close();
    }
    expect(fs.readdirSync(path.join(root, 'moved'))).toEqual([]);
    expect(fs.readdirSync(outside)).toEqual(['keep']);
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf-8')).toBe('keep');
  });

  it('removes children whose on-disk names carry odd or non-UTF8 bytes', () => {
    // Filenames are raw bytes on Unix; the recursive walk must delete each one
    // by its real name, not abort partway and strand the rest.
    fs.mkdirSync(path.join(root, 'skill'));
    fs.writeFileSync(path.join(root, 'skill', 'SKILL.md'), 'skill');
    fs.writeFileSync(path.join(root, 'skill', 'report\\2026.md'), 'odd');
    // A raw 0xff byte is a valid Linux filename but rejected on UTF-8-only
    // filesystems (APFS) — exercise it where the platform allows, skip where not.
    try {
      fs.writeFileSync(Buffer.concat([Buffer.from(path.join(root, 'skill') + '/'), Buffer.from([0xff])]), 'raw');
    } catch {
      /* filesystem rejects non-UTF8 names */
    }
    const dir = openOrThrow([]);
    try {
      dir.remove('skill', true);
      expect(dir.entries()).toEqual([]);
    } finally {
      dir.close();
    }
  });

  it('copies only the supplied file tree into the pinned directory and preserves executable permissions', () => {
    fs.mkdirSync(path.join(root, 'src', 'scripts', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'SKILL.md'), 'skill');
    fs.writeFileSync(path.join(root, 'src', 'scripts', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'src', 'scripts', 'nested', 'data'), 'data');
    fs.writeFileSync(path.join(root, 'src', 'unlisted'), 'not selected');
    const src = openOrThrow(['src']);
    const dst = openOrThrow(['dst'], true);
    try {
      fs.renameSync(path.join(root, 'dst'), path.join(root, 'moved'));
      fs.symlinkSync(outside, path.join(root, 'dst'));
      dst.copyFiles(src, 'skill', ['SKILL.md', 'scripts/run.sh', 'scripts/nested/data']);
    } finally {
      src.close();
      dst.close();
    }
    const copied = path.join(root, 'moved', 'skill');
    expect(fs.readdirSync(copied)).toEqual(['SKILL.md', 'scripts']);
    expect(fs.readFileSync(path.join(copied, 'SKILL.md'), 'utf-8')).toBe('skill');
    expect(fs.readFileSync(path.join(copied, 'scripts', 'run.sh'), 'utf-8')).toBe('#!/bin/sh\n');
    expect(fs.statSync(path.join(copied, 'scripts', 'run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(copied, 'scripts', 'nested', 'data'), 'utf-8')).toBe('data');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each(['file', 'directory', 'symlink'])('refuses a copy destination occupied by a %s', (kind) => {
    const src = openOrThrow(['src'], true);
    const dst = openOrThrow(['dst'], true);
    const taken = path.join(root, 'dst', 'taken');
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    if (kind === 'file') fs.writeFileSync(taken, 'keep');
    if (kind === 'directory') fs.mkdirSync(taken);
    if (kind === 'symlink') fs.symlinkSync(outside, taken);
    try {
      src.writeNewFile('file', Buffer.from('new'));
      expect(() => dst.copyFiles(src, 'taken', ['file'])).toThrow(/EEXIST/);
      if (kind === 'file') expect(fs.readFileSync(taken, 'utf-8')).toBe('keep');
      if (kind === 'directory') expect(fs.readdirSync(taken)).toEqual([]);
      if (kind === 'symlink') expect(fs.readlinkSync(taken)).toBe(outside);
    } finally {
      src.close();
      dst.close();
    }
    expect(fs.readdirSync(outside)).toEqual(['keep']);
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf-8')).toBe('keep');
  });

  it.each(['file', 'directory'])('refuses a %s name occupied while copying a tree', (kind) => {
    fs.mkdirSync(path.join(root, 'src', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'scripts', 'run.sh'), 'new');
    fs.writeFileSync(path.join(root, 'src', 'SKILL.md'), 'new');
    const src = openOrThrow(['src']);
    const dst = openOrThrow(['dst'], true);
    const openDir = AnchoredDir.prototype.openDir;
    vi.spyOn(AnchoredDir.prototype, 'openDir').mockImplementation(function (this: AnchoredDir, name, create) {
      const dir = openDir.call(this, name, create);
      if (name === 'copy' && dir) {
        if (kind === 'file') dir.writeNewFile('SKILL.md', Buffer.from('keep'));
        else dir.openDir('scripts', true)!.close();
      }
      return dir;
    });
    try {
      expect(() => dst.copyFiles(src, 'copy', ['SKILL.md', 'scripts/run.sh'])).toThrow(/EEXIST/);
    } finally {
      src.close();
      dst.close();
    }
    const copied = path.join(root, 'dst', 'copy');
    if (kind === 'file') expect(fs.readFileSync(path.join(copied, 'SKILL.md'), 'utf-8')).toBe('keep');
    else expect(fs.readdirSync(path.join(copied, 'scripts'))).toEqual([]);
  });
});
