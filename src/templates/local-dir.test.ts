import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isValidTemplateRef, resolveLocalTemplate } from './local-dir.js';

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

describe('isValidTemplateRef', () => {
  it('accepts plain one- and multi-segment refs', () => {
    expect(isValidTemplateRef('sdr')).toBe(true);
    expect(isValidTemplateRef('sales/sdr')).toBe(true);
    expect(isValidTemplateRef('data/analyst_v2.1')).toBe(true);
  });

  it('rejects anything that could leave the templates base or is not a plain name', () => {
    for (const ref of [
      '',
      '..',
      'sales/../etc',
      '/etc',
      '~/x',
      'sales//sdr',
      'sales/',
      ' sales/sdr',
      'a\\b',
      '.hidden/x',
      'sales/-x',
      'x'.repeat(129),
    ]) {
      expect(isValidTemplateRef(ref)).toBe(false);
    }
  });
});
