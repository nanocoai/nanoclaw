/**
 * Behavioural tests for the file helpers in `fs-hygiene.ts`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readTextNoFollow, writeTextAtomic, writeTextIfAbsent } from './fs-hygiene.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hygiene-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readTextNoFollow', () => {
  it('reads a regular file', () => {
    fs.writeFileSync(path.join(dir, 'f.json'), '{"a":1}');
    expect(readTextNoFollow(path.join(dir, 'f.json'))).toBe('{"a":1}');
  });

  it('returns null for a missing file', () => {
    expect(readTextNoFollow(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null when the name is a directory', () => {
    fs.mkdirSync(path.join(dir, 'f.json'));
    expect(readTextNoFollow(path.join(dir, 'f.json'))).toBeNull();
  });

  it('preserves content exactly, including trailing whitespace', () => {
    fs.writeFileSync(path.join(dir, 'f.md'), 'line\n\n  \n');
    expect(readTextNoFollow(path.join(dir, 'f.md'))).toBe('line\n\n  \n');
  });

  it('leaves no file descriptor behind across many reads', () => {
    fs.writeFileSync(path.join(dir, 'f.json'), 'x');
    for (let i = 0; i < 500; i++) expect(readTextNoFollow(path.join(dir, 'f.json'))).toBe('x');
  });
});

describe('writeTextAtomic', () => {
  it('publishes the content at the destination', () => {
    writeTextAtomic(path.join(dir, 'out.md'), 'hello');
    expect(fs.readFileSync(path.join(dir, 'out.md'), 'utf-8')).toBe('hello');
  });

  it('overwrites its own previous output', () => {
    writeTextAtomic(path.join(dir, 'out.md'), 'first');
    writeTextAtomic(path.join(dir, 'out.md'), 'second');
    expect(fs.readFileSync(path.join(dir, 'out.md'), 'utf-8')).toBe('second');
  });

  it('leaves no staging file behind', () => {
    writeTextAtomic(path.join(dir, 'out.md'), 'hello');
    expect(fs.readdirSync(dir)).toEqual(['out.md']);
  });

  it('does not reuse one staging name across writes', () => {
    // Repeated writes from one process must not collide on a single staging
    // name, so the name cannot be derived from the pid alone.
    const target = path.join(dir, 'out.md');
    for (let i = 0; i < 20; i++) writeTextAtomic(target, `v${i}`);
    expect(fs.readdirSync(dir)).toEqual(['out.md']);
    expect(fs.readFileSync(target, 'utf-8')).toBe('v19');
  });

  it('publishes a regular file at the destination', () => {
    writeTextAtomic(path.join(dir, 'out.md'), 'hello');
    expect(fs.lstatSync(path.join(dir, 'out.md')).isFile()).toBe(true);
  });
});

describe('writeTextIfAbsent', () => {
  it('creates the file and reports that it did', () => {
    expect(writeTextIfAbsent(path.join(dir, 'settings.json'), '{}')).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe('{}');
  });

  it('reports false and changes nothing when the name is taken', () => {
    fs.writeFileSync(path.join(dir, 'settings.json'), 'EXISTING');
    expect(writeTextIfAbsent(path.join(dir, 'settings.json'), '{}')).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe('EXISTING');
  });

  it('reports false when the name is held by a directory', () => {
    fs.mkdirSync(path.join(dir, 'settings.json'));
    expect(writeTextIfAbsent(path.join(dir, 'settings.json'), '{}')).toBe(false);
  });

  it('is safe to call repeatedly — only the first call creates', () => {
    expect(writeTextIfAbsent(path.join(dir, 'settings.json'), 'first')).toBe(true);
    expect(writeTextIfAbsent(path.join(dir, 'settings.json'), 'second')).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).toBe('first');
  });
});
