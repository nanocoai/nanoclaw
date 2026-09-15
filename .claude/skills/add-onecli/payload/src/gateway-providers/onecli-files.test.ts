import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stageOnecliFile } from './onecli-files.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-onecli-files-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistent OneCLI files', () => {
  it('publishes only a complete file when several processes stage the same content', async () => {
    const moduleUrl = new URL('./onecli-files.ts', import.meta.url).href;
    const script = `import {stageOnecliFile} from ${JSON.stringify(moduleUrl)}; console.log(stageOnecliFile(process.argv[1], 'ca', 'CA'.repeat(50000)));`;
    const outputs = await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir]),
      ),
    );
    const destinations = outputs.map((o) => o.stdout.trim());
    expect(new Set(destinations).size).toBe(1);
    expect(fs.readFileSync(destinations[0], 'utf8')).toBe('CA'.repeat(50000));
    expect(fs.readdirSync(path.join(dir, 'onecli'))).toEqual([path.basename(destinations[0])]);
    expect(fs.statSync(path.join(dir, 'onecli')).mode & 0o777).toBe(0o700);
  });

  it.each(['directory', 'symlink'] as const)(
    'refuses an existing %s collision without replacing it or unrelated files',
    (collision) => {
      const file = stageOnecliFile(dir, 'ca', 'CA');
      const unrelated = path.join(dir, 'keep');
      fs.writeFileSync(unrelated, 'keep');
      fs.unlinkSync(file);
      if (collision === 'directory') fs.mkdirSync(file);
      else fs.symlinkSync(unrelated, file);
      const before = fs.lstatSync(file);
      expect(() => stageOnecliFile(dir, 'ca', 'CA')).toThrow(/OneCLI staged file/);
      expect(fs.lstatSync(file).ino).toBe(before.ino);
      expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep');
      expect(fs.readdirSync(path.join(dir, 'onecli'))).toEqual([path.basename(file)]);
    },
  );

  it.each(['content', 'permissions'] as const)('repairs an owned regular file with mismatched %s', (mismatch) => {
    const file = stageOnecliFile(dir, 'ca', 'CA');
    const before = fs.lstatSync(file).ino;
    if (mismatch === 'content') fs.writeFileSync(file, 'wrong');
    else fs.chmodSync(file, 0o600);

    expect(stageOnecliFile(dir, 'ca', 'CA')).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('CA');
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(file).ino).not.toBe(before);
    expect(fs.readdirSync(path.join(dir, 'onecli'))).toEqual([path.basename(file)]);
  });

  it('refuses a staged file owned by another user', () => {
    const file = stageOnecliFile(dir, 'ca', 'CA');
    const stat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      const result = Reflect.apply(stat, fs, [target, ...args]) as fs.Stats;
      if (target === file) result.uid += 1;
      return result;
    }) as typeof fs.lstatSync);
    expect(() => stageOnecliFile(dir, 'ca', 'CA')).toThrow(/owner/);
    expect(fs.readFileSync(file, 'utf8')).toBe('CA');
  });

  it.each(['symlink', 'permissions'] as const)('refuses an unsafe staging directory: %s', (kind) => {
    const directory = path.join(dir, 'onecli');
    if (kind === 'symlink') fs.symlinkSync(dir, directory);
    else fs.mkdirSync(directory, { mode: 0o755 });
    expect(() => stageOnecliFile(dir, 'ca', 'CA')).toThrow(/OneCLI file directory/);
    expect(fs.readdirSync(dir)).toEqual(['onecli']);
  });

  it('removes only its unpublished temporary file after a failed write', () => {
    fs.mkdirSync(path.join(dir, 'onecli'), { mode: 0o700 });
    const unrelated = path.join(dir, 'onecli', '.pending-unrelated');
    fs.writeFileSync(unrelated, 'keep');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('full'), { code: 'ENOSPC' });
    });
    expect(() => stageOnecliFile(dir, 'stub', 'sensitive')).toThrow('full');
    expect(fs.readdirSync(path.join(dir, 'onecli'))).toEqual(['.pending-unrelated']);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep');
  });
});
