import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendToEnvList, readEnvValue, upsertEnvKey } from './env-file.js';

describe('env-file', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const envPath = (): string => path.join(rootDir, '.env');
  const write = (text: string): void => fs.writeFileSync(envPath(), text);
  const read = (): string => fs.readFileSync(envPath(), 'utf-8');

  describe('readEnvValue', () => {
    it('returns undefined when .env is absent', () => {
      expect(readEnvValue(rootDir, 'ENVF_TEST_MISSING')).toBeUndefined();
    });

    it('parses with src/env.ts semantics: comments, blanks, quotes, whitespace', () => {
      write(
        [
          '# leading comment',
          '',
          'ENVF_PLAIN=value1',
          '  ENVF_INDENTED = spaced ',
          'ENVF_DQUOTED="double quoted"',
          "ENVF_SQUOTED='single quoted'",
          'ENVF_EMPTY=',
          '# ENVF_COMMENTED=nope',
          'NOT_AN_ASSIGNMENT',
        ].join('\n'),
      );
      expect(readEnvValue(rootDir, 'ENVF_PLAIN')).toBe('value1');
      expect(readEnvValue(rootDir, 'ENVF_INDENTED')).toBe('spaced');
      expect(readEnvValue(rootDir, 'ENVF_DQUOTED')).toBe('double quoted');
      expect(readEnvValue(rootDir, 'ENVF_SQUOTED')).toBe('single quoted');
      expect(readEnvValue(rootDir, 'ENVF_EMPTY')).toBeUndefined();
      expect(readEnvValue(rootDir, 'ENVF_COMMENTED')).toBeUndefined();
    });

    it('prefers process.env over the file', () => {
      write('ENVF_PREFERS=file-value\n');
      vi.stubEnv('ENVF_PREFERS', 'env-value');
      expect(readEnvValue(rootDir, 'ENVF_PREFERS')).toBe('env-value');
    });

    it('falls through a blank process.env value to the file', () => {
      write('ENVF_BLANK_ENV=file-value\n');
      vi.stubEnv('ENVF_BLANK_ENV', '   ');
      expect(readEnvValue(rootDir, 'ENVF_BLANK_ENV')).toBe('file-value');
    });

    it('last duplicate line wins, matching readEnvFile', () => {
      write('ENVF_DUP=first\nENVF_DUP=second\n');
      expect(readEnvValue(rootDir, 'ENVF_DUP')).toBe('second');
    });
  });

  describe('upsertEnvKey', () => {
    it('creates .env when absent', () => {
      upsertEnvKey(rootDir, 'ENVF_NEW', 'v1');
      expect(read()).toBe('ENVF_NEW=v1\n');
      expect(readEnvValue(rootDir, 'ENVF_NEW')).toBe('v1');
    });

    it('appends after a file without a trailing newline', () => {
      write('EXISTING=x');
      upsertEnvKey(rootDir, 'ENVF_APPENDED', 'v2');
      expect(read()).toBe('EXISTING=x\nENVF_APPENDED=v2\n');
    });

    it('replaces in place, preserving unrelated lines and comments', () => {
      write('# keep me\nFIRST=1\nENVF_TARGET=old\nLAST=9\n');
      upsertEnvKey(rootDir, 'ENVF_TARGET', 'new');
      expect(read()).toBe('# keep me\nFIRST=1\nENVF_TARGET=new\nLAST=9\n');
    });

    it('does not touch keys that merely share a prefix', () => {
      write('ENVF_KEY=keep\nENVF_KEY_LONGER=keep-too\n');
      upsertEnvKey(rootDir, 'ENVF_KEY', 'changed');
      expect(read()).toBe('ENVF_KEY=changed\nENVF_KEY_LONGER=keep-too\n');
    });

    it('rewrites every duplicate line so a stale value can never win the read', () => {
      write('ENVF_DUP=first\nENVF_DUP=second\n');
      upsertEnvKey(rootDir, 'ENVF_DUP', 'final');
      expect(read()).toBe('ENVF_DUP=final\nENVF_DUP=final\n');
      expect(readEnvValue(rootDir, 'ENVF_DUP')).toBe('final');
    });

    it('replaces an indented assignment (readable lines are writable lines)', () => {
      write('  ENVF_INDENTED=old\n');
      upsertEnvKey(rootDir, 'ENVF_INDENTED', 'new');
      expect(readEnvValue(rootDir, 'ENVF_INDENTED')).toBe('new');
      expect(read()).not.toContain('old');
    });
  });

  describe('appendToEnvList', () => {
    it('creates the key and reports the entry as new', () => {
      expect(appendToEnvList(rootDir, 'ENVF_LIST', 'alpha')).toBe(true);
      expect(readEnvValue(rootDir, 'ENVF_LIST')).toBe('alpha');
    });

    it('unions new entries and preserves existing ones', () => {
      write('ENVF_LIST=alpha, beta\n');
      expect(appendToEnvList(rootDir, 'ENVF_LIST', 'gamma')).toBe(true);
      expect(readEnvValue(rootDir, 'ENVF_LIST')).toBe('alpha,beta,gamma');
    });

    it('is idempotent: an existing entry returns false and leaves the file alone', () => {
      write('ENVF_LIST=alpha,beta\nOTHER=1\n');
      const before = read();
      expect(appendToEnvList(rootDir, 'ENVF_LIST', 'beta')).toBe(false);
      expect(read()).toBe(before);
    });

    it('unions against the file value even when process.env differs', () => {
      // Readers of list keys parse .env only, so the union must be based on
      // the file, not a stale process.env copy.
      write('ENVF_LIST=alpha\n');
      vi.stubEnv('ENVF_LIST', 'alpha,from-process-env');
      expect(appendToEnvList(rootDir, 'ENVF_LIST', 'beta')).toBe(true);
      expect(read()).toContain('ENVF_LIST=alpha,beta');
    });
  });
});
