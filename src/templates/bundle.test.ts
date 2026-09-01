import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { bundleFromDir, materializeBundle, parseBundle } from './bundle.js';

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('template bundle codec', () => {
  it('round-trips a directory byte for byte, modes included', () => {
    const src = tmp();
    fs.mkdirSync(path.join(src, 'ai.nanoco.nanoclaw', 'context'), { recursive: true });
    fs.writeFileSync(path.join(src, 'plugin.json'), '{"name":"x"}\n');
    fs.writeFileSync(path.join(src, 'ai.nanoco.nanoclaw', 'context', 'instructions.md'), '# héllo\n');
    fs.mkdirSync(path.join(src, 'skills', 's', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(src, 'skills', 's', 'scripts', 'run.mjs'), '#!/usr/bin/env node\n', { mode: 0o755 });
    fs.writeFileSync(path.join(src, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));

    const bundle = parseBundle(JSON.stringify(bundleFromDir(src)));
    expect(Object.keys(bundle.files).sort()).toEqual([
      'ai.nanoco.nanoclaw/context/instructions.md', 'blob.bin', 'plugin.json', 'skills/s/scripts/run.mjs',
    ]);
    expect(bundle.files['blob.bin']!.base64).toBeDefined();
    expect(bundle.files['skills/s/scripts/run.mjs']!.mode! & 0o111).not.toBe(0);

    const out = path.join(tmp(), 'out');
    materializeBundle(bundle, out);
    for (const rel of Object.keys(bundle.files)) {
      expect(fs.readFileSync(path.join(out, rel))).toEqual(fs.readFileSync(path.join(src, rel)));
    }
    expect(fs.statSync(path.join(out, 'skills/s/scripts/run.mjs')).mode & 0o111).not.toBe(0);
  });

  it('refuses paths that escape, symlinks, and malformed files', () => {
    expect(() => parseBundle(JSON.stringify({ files: { '../x': { text: '' } } }))).toThrow(/safe relative path/);
    expect(() => parseBundle(JSON.stringify({ files: { '/abs': { text: '' } } }))).toThrow(/safe relative path/);
    expect(() => parseBundle(JSON.stringify({ files: { 'a/./b': { text: '' } } }))).toThrow(/safe relative path/);
    expect(() => parseBundle(JSON.stringify({ files: { a: { text: 'x', base64: 'eA==' } } }))).toThrow(/exactly one/);
    expect(() => parseBundle(JSON.stringify({ files: {} }))).toThrow(/no files/);
    const src = tmp();
    fs.writeFileSync(path.join(src, 'real'), 'x');
    fs.symlinkSync('/etc/passwd', path.join(src, 'link'));
    expect(() => bundleFromDir(src)).toThrow(/symlink/);
  });

  it('will not materialize over an existing path', () => {
    const out = tmp();
    expect(() => materializeBundle({ files: { a: { text: '1' } } }, out)).toThrow(/existing path/);
  });
});
