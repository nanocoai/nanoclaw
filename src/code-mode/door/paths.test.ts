import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { doorFiles, forcedCommandOption, resolveEntry, shellQuote, sshdConfigArg } from './paths.js';
import { accountNameError, validateAccountName } from './name.js';

describe('door paths', () => {
  it('keeps every door file in one directory', () => {
    const files = doorFiles('/srv/host/data/door');
    expect(Object.values(files).every((f) => f.startsWith('/srv/host/data/door'))).toBe(true);
    expect(path.basename(files.keyStore)).toBe('keys.json');
    expect(path.basename(files.hostSocket)).toBe('host.sock');
  });

  it('resolves an entry to the running tree with the given Node binary', () => {
    const argv = resolveEntry('landing', '/opt/node/bin/node');
    expect(argv[0]).toBe('/opt/node/bin/node');
    expect(argv.every((a) => path.isAbsolute(a))).toBe(true);
    expect(argv[argv.length - 1]).toMatch(/[\\/]code-mode[\\/]door[\\/]landing\.[jt]s$/);
  });

  it('quotes for the login shell and for the authorized_keys option layer', () => {
    expect(shellQuote(`it's`)).toBe(`'it'\\''s'`);
    expect(forcedCommandOption(['/bin/prog', 'a b', 'say "hi"'])).toBe(`command="'/bin/prog' 'a b' 'say \\"hi\\"'"`);
    expect(() => forcedCommandOption(['/bin/prog', 'two\nlines'])).toThrow(/line breaks/);
  });

  it('quotes sshd_config arguments and refuses what the server cannot carry', () => {
    expect(sshdConfigArg('/srv/with space/x')).toBe('"/srv/with space/x"');
    expect(sshdConfigArg('/srv/50%')).toBe('"/srv/50%%"');
    expect(() => sshdConfigArg('/srv/"x"')).toThrow();
    expect(() => sshdConfigArg('/srv/back\\slash')).toThrow();
    expect(() => sshdConfigArg('/srv/tab\tx')).toThrow();
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
