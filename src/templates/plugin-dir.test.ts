import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_PLUGIN_FILES, MAX_PLUGIN_TOTAL_BYTES, copyPluginDir, walkPluginDir } from './plugin-dir.js';

let root: string;
let src: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dir-'));
  src = path.join(root, 'src');
  fs.mkdirSync(src);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const full = path.join(src, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('walkPluginDir', () => {
  it('rejects a symlinked file — the copy path must never follow links', () => {
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'host secret');
    write('plugin.json', '{}');
    fs.symlinkSync(outside, path.join(src, 'stolen.txt'));

    expect(() => walkPluginDir(src)).toThrow(/symlink/);
  });

  it('rejects a symlinked directory', () => {
    fs.mkdirSync(path.join(root, 'outside-dir'));
    write('plugin.json', '{}');
    fs.symlinkSync(path.join(root, 'outside-dir'), path.join(src, 'sub'));

    expect(() => walkPluginDir(src)).toThrow(/symlink/);
  });

  it(`rejects more than ${MAX_PLUGIN_FILES} files`, () => {
    for (let i = 0; i <= MAX_PLUGIN_FILES; i++) fs.writeFileSync(path.join(src, `f${i}`), 'x');
    expect(() => walkPluginDir(src)).toThrow(/more than \d+ entries/);
  });

  it('counts directories toward the entry cap (breadth bomb)', () => {
    for (let i = 0; i <= MAX_PLUGIN_FILES; i++) fs.mkdirSync(path.join(src, `d${i}`));
    expect(() => walkPluginDir(src)).toThrow(/more than \d+ entries/);
  });

  it('rejects a plugin root that is itself a symlink', () => {
    fs.writeFileSync(path.join(src, 'plugin.json'), '{}');
    const link = path.join(root, 'link-root');
    fs.symlinkSync(src, link);
    expect(() => walkPluginDir(link)).toThrow(/regular directory/);
  });

  it('rejects a tree over the total-bytes cap', () => {
    write('big.bin', Buffer.alloc(MAX_PLUGIN_TOTAL_BYTES + 1));
    expect(() => walkPluginDir(src)).toThrow(/total size/);
  });

  it('rejects nesting deeper than the depth cap', () => {
    const deep = Array.from({ length: 17 }, (_, i) => `d${i}`).join('/');
    write(`${deep}/leaf.txt`, 'x');
    expect(() => walkPluginDir(src)).toThrow(/nesting depth/);
  });

  it('returns every regular file with its plugin-relative path', () => {
    write('plugin.json', '{}');
    write('skills/a/SKILL.md', 'skill');
    expect(
      walkPluginDir(src)
        .map((f) => f.rel)
        .sort(),
    ).toEqual(['plugin.json', 'skills/a/SKILL.md']);
  });
});

describe('copyPluginDir', () => {
  it('copies the tree, preserves the executable bit, and replaces stale content', () => {
    write('plugin.json', '{}');
    write('skills/a/scripts/run.sh', '#!/bin/sh\n');
    fs.chmodSync(path.join(src, 'skills/a/scripts/run.sh'), 0o755);

    const dest = path.join(root, 'dest');
    fs.mkdirSync(path.join(dest, 'old'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'old', 'stale.txt'), 'stale');

    copyPluginDir(src, dest);

    expect(fs.readFileSync(path.join(dest, 'plugin.json'), 'utf-8')).toBe('{}');
    expect(fs.statSync(path.join(dest, 'skills/a/scripts/run.sh')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(dest, 'old'))).toBe(false);
  });

  it('copies nothing when validation fails', () => {
    write('plugin.json', '{}');
    fs.symlinkSync('/etc/hosts', path.join(src, 'link'));

    const dest = path.join(root, 'dest');
    expect(() => copyPluginDir(src, dest)).toThrow(/symlink/);
    expect(fs.existsSync(dest)).toBe(false);
  });
});
