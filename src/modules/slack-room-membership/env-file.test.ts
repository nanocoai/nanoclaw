/**
 * Tests for the module's vendored .env helpers — the read/append pair only
 * (the upsert writer is private, exercised through appendToEnvList).
 * Semantics must stay identical to src/env.ts readEnvFile parsing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendToEnvList, readEnvValue } from './env-file.js';

describe('slack-room-membership env-file', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srm-env-'));
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
      expect(readEnvValue(rootDir, 'SRM_TEST_MISSING')).toBeUndefined();
    });

    it('parses with src/env.ts semantics: comments, blanks, quotes, whitespace', () => {
      write(
        [
          '# leading comment',
          '',
          'SRM_PLAIN=value1',
          '  SRM_INDENTED = spaced ',
          'SRM_DQUOTED="double quoted"',
          "SRM_SQUOTED='single quoted'",
          'SRM_EMPTY=',
          '# SRM_COMMENTED=nope',
          'NOT_AN_ASSIGNMENT',
        ].join('\n'),
      );
      expect(readEnvValue(rootDir, 'SRM_PLAIN')).toBe('value1');
      expect(readEnvValue(rootDir, 'SRM_INDENTED')).toBe('spaced');
      expect(readEnvValue(rootDir, 'SRM_DQUOTED')).toBe('double quoted');
      expect(readEnvValue(rootDir, 'SRM_SQUOTED')).toBe('single quoted');
      expect(readEnvValue(rootDir, 'SRM_EMPTY')).toBeUndefined();
      expect(readEnvValue(rootDir, 'SRM_COMMENTED')).toBeUndefined();
    });

    it('prefers process.env over the file', () => {
      write('SRM_PREFERS=file-value\n');
      vi.stubEnv('SRM_PREFERS', 'env-value');
      expect(readEnvValue(rootDir, 'SRM_PREFERS')).toBe('env-value');
    });

    it('falls through a blank process.env value to the file', () => {
      write('SRM_BLANK_ENV=file-value\n');
      vi.stubEnv('SRM_BLANK_ENV', '   ');
      expect(readEnvValue(rootDir, 'SRM_BLANK_ENV')).toBe('file-value');
    });

    it('last duplicate line wins, matching readEnvFile', () => {
      write('SRM_DUP=first\nSRM_DUP=second\n');
      expect(readEnvValue(rootDir, 'SRM_DUP')).toBe('second');
    });
  });

  describe('appendToEnvList', () => {
    it('creates .env and the key, reporting the entry as new', () => {
      expect(appendToEnvList(rootDir, 'SRM_LIST', 'alpha')).toBe(true);
      expect(read()).toBe('SRM_LIST=alpha\n');
      expect(readEnvValue(rootDir, 'SRM_LIST')).toBe('alpha');
    });

    it('unions new entries and preserves existing ones', () => {
      write('SRM_LIST=alpha, beta\n');
      expect(appendToEnvList(rootDir, 'SRM_LIST', 'gamma')).toBe(true);
      expect(readEnvValue(rootDir, 'SRM_LIST')).toBe('alpha,beta,gamma');
    });

    it('replaces in place, preserving unrelated lines and comments', () => {
      write('# keep me\nFIRST=1\nSRM_LIST=alpha\nLAST=9\n');
      expect(appendToEnvList(rootDir, 'SRM_LIST', 'beta')).toBe(true);
      expect(read()).toBe('# keep me\nFIRST=1\nSRM_LIST=alpha,beta\nLAST=9\n');
    });

    it('appends after a file without a trailing newline', () => {
      write('EXISTING=x');
      expect(appendToEnvList(rootDir, 'SRM_LIST', 'alpha')).toBe(true);
      expect(read()).toBe('EXISTING=x\nSRM_LIST=alpha\n');
    });

    it('rewrites every duplicate line so a stale value can never win the read', () => {
      write('SRM_LIST=alpha\nSRM_LIST=beta\n');
      expect(appendToEnvList(rootDir, 'SRM_LIST', 'gamma')).toBe(true);
      expect(read()).toBe('SRM_LIST=beta,gamma\nSRM_LIST=beta,gamma\n');
      expect(readEnvValue(rootDir, 'SRM_LIST')).toBe('beta,gamma');
    });

    it('is idempotent: an existing entry returns false and leaves the file alone', () => {
      write('SRM_LIST=alpha,beta\nOTHER=1\n');
      const before = read();
      expect(appendToEnvList(rootDir, 'SRM_LIST', 'beta')).toBe(false);
      expect(read()).toBe(before);
    });

    it('unions against the file value even when process.env differs', () => {
      // Readers of list keys parse .env only, so the union must be based on
      // the file, not a stale process.env copy.
      write('SRM_LIST=alpha\n');
      vi.stubEnv('SRM_LIST', 'alpha,from-process-env');
      expect(appendToEnvList(rootDir, 'SRM_LIST', 'beta')).toBe(true);
      expect(read()).toContain('SRM_LIST=alpha,beta');
    });
  });
});
