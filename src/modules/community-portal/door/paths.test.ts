import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { doorFiles } from './paths.js';
import { accountNameError, validateAccountName } from './name.js';

describe('door paths', () => {
  it('keeps every door file in one directory', () => {
    const files = doorFiles('/srv/host/data/door');
    expect(Object.values(files).every((f) => f.startsWith('/srv/host/data/door'))).toBe(true);
    expect(path.basename(files.keyStore)).toBe('keys.json');
    expect(path.basename(files.hostKey)).toBe('host_ed25519');
    expect(path.basename(files.hostKeyPublic)).toBe('host_ed25519.pub');
    expect(path.basename(files.state)).toBe('state.json');
  });
});

describe('account names', () => {
  it('accepts DNS labels of 3–32 lowercase characters', () => {
    for (const ok of ['abc', 'my-machine', 'a1b2', 'x'.repeat(32)]) expect(accountNameError(ok)).toBeUndefined();
    expect(validateAccountName('alice')).toBe('alice');
  });

  it('rejects length, case, punctuation, edge hyphens and the reserved folder name', () => {
    expect(accountNameError('ab')).toMatch(/3–32/);
    expect(accountNameError('x'.repeat(33))).toMatch(/3–32/);
    expect(accountNameError('MyBox')).toMatch(/lowercase/);
    expect(accountNameError('my_box')).toMatch(/lowercase/);
    expect(accountNameError('-abc')).toMatch(/hyphen/);
    expect(accountNameError('abc-')).toMatch(/hyphen/);
    expect(accountNameError('ab--cd')).toMatch(/hyphen/);
    expect(accountNameError('www')).toMatch(/reserved/);
    expect(accountNameError('sandbox')).toMatch(/reserved/);
    expect(accountNameError('a.b.c')).toMatch(/lowercase/);
    expect(accountNameError('global')).toMatch(/reserved/);
    expect(() => validateAccountName('Nope')).toThrow(/invalid account name "Nope"/);
  });
});
