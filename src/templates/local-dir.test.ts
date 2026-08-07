import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveLocalTemplate } from './local-dir.js';

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-local-'));
  fs.mkdirSync(path.join(base, 'sales', 'sdr'), { recursive: true });
  fs.writeFileSync(path.join(base, 'afile.md'), 'not a directory');
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('resolveLocalTemplate', () => {
  it('resolves a valid multi-segment relative ref under the base', () => {
    expect(resolveLocalTemplate('sales/sdr', base)).toBe(path.join(base, 'sales', 'sdr'));
  });

  it('rejects a ref that escapes the base via ../', () => {
    expect(() => resolveLocalTemplate('../escape', base)).toThrow(/escapes/);
  });

  it('rejects a multi-segment escape like sales/../../etc', () => {
    expect(() => resolveLocalTemplate('sales/../../etc', base)).toThrow(/escapes/);
  });

  it('rejects an absolute ref', () => {
    expect(() => resolveLocalTemplate('/etc', base)).toThrow(/relative/);
  });

  it('rejects a ~-prefixed ref', () => {
    expect(() => resolveLocalTemplate('~/x', base)).toThrow(/relative/);
  });

  it('rejects empty and whitespace-only refs', () => {
    expect(() => resolveLocalTemplate('', base)).toThrow(/Invalid/);
    expect(() => resolveLocalTemplate('   ', base)).toThrow(/Invalid/);
  });

  it('rejects an untrimmed ref', () => {
    expect(() => resolveLocalTemplate(' sales/sdr', base)).toThrow(/Invalid/);
  });

  it('throws when the ref does not exist', () => {
    expect(() => resolveLocalTemplate('nope', base)).toThrow(/not found/i);
  });

  it('throws when the ref is a file, not a directory', () => {
    expect(() => resolveLocalTemplate('afile.md', base)).toThrow(/not found/i);
  });
});
