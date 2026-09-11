import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendToEnvList, readEnvValue, upsertEnvKey } from './env-file.js';

describe('slack-agent-flow env-file', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-env-'));
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
      expect(readEnvValue(rootDir, 'SAF_TEST_MISSING')).toBeUndefined();
    });

    it('parses with src/env.ts semantics: comments, blanks, quotes, whitespace', () => {
      write(
        [
          '# leading comment',
          '',
          'SAF_PLAIN=value1',
          '  SAF_INDENTED = spaced ',
          'SAF_DQUOTED="double quoted"',
          "SAF_SQUOTED='single quoted'",
          'SAF_EMPTY=',
          '# SAF_COMMENTED=nope',
          'NOT_AN_ASSIGNMENT',
        ].join('\n'),
      );
      expect(readEnvValue(rootDir, 'SAF_PLAIN')).toBe('value1');
      expect(readEnvValue(rootDir, 'SAF_INDENTED')).toBe('spaced');
      expect(readEnvValue(rootDir, 'SAF_DQUOTED')).toBe('double quoted');
      expect(readEnvValue(rootDir, 'SAF_SQUOTED')).toBe('single quoted');
      expect(readEnvValue(rootDir, 'SAF_EMPTY')).toBeUndefined();
      expect(readEnvValue(rootDir, 'SAF_COMMENTED')).toBeUndefined();
    });

    it('prefers process.env over the file', () => {
      write('SAF_PREFERS=file-value\n');
      vi.stubEnv('SAF_PREFERS', 'env-value');
      expect(readEnvValue(rootDir, 'SAF_PREFERS')).toBe('env-value');
    });

    it('falls through a blank process.env value to the file', () => {
      write('SAF_BLANK_ENV=file-value\n');
      vi.stubEnv('SAF_BLANK_ENV', '   ');
      expect(readEnvValue(rootDir, 'SAF_BLANK_ENV')).toBe('file-value');
    });

    it('last duplicate line wins, matching readEnvFile', () => {
      write('SAF_DUP=first\nSAF_DUP=second\n');
      expect(readEnvValue(rootDir, 'SAF_DUP')).toBe('second');
    });
  });

  describe('upsertEnvKey', () => {
    it('creates .env when absent', () => {
      upsertEnvKey(rootDir, 'SAF_NEW', 'v1');
      expect(read()).toBe('SAF_NEW=v1\n');
      expect(readEnvValue(rootDir, 'SAF_NEW')).toBe('v1');
    });

    it('appends after a file without a trailing newline', () => {
      write('EXISTING=x');
      upsertEnvKey(rootDir, 'SAF_APPENDED', 'v2');
      expect(read()).toBe('EXISTING=x\nSAF_APPENDED=v2\n');
    });

    it('replaces in place, preserving unrelated lines and comments', () => {
      write('# keep me\nFIRST=1\nSAF_TARGET=old\nLAST=9\n');
      upsertEnvKey(rootDir, 'SAF_TARGET', 'new');
      expect(read()).toBe('# keep me\nFIRST=1\nSAF_TARGET=new\nLAST=9\n');
    });

    it('does not touch keys that merely share a prefix', () => {
      write('SAF_KEY=keep\nSAF_KEY_LONGER=keep-too\n');
      upsertEnvKey(rootDir, 'SAF_KEY', 'changed');
      expect(read()).toBe('SAF_KEY=changed\nSAF_KEY_LONGER=keep-too\n');
    });

    it('rewrites every duplicate line so a stale value can never win the read', () => {
      write('SAF_DUP=first\nSAF_DUP=second\n');
      upsertEnvKey(rootDir, 'SAF_DUP', 'final');
      expect(read()).toBe('SAF_DUP=final\nSAF_DUP=final\n');
      expect(readEnvValue(rootDir, 'SAF_DUP')).toBe('final');
    });

    it('replaces an indented assignment (readable lines are writable lines)', () => {
      write('  SAF_INDENTED=old\n');
      upsertEnvKey(rootDir, 'SAF_INDENTED', 'new');
      expect(readEnvValue(rootDir, 'SAF_INDENTED')).toBe('new');
      expect(read()).not.toContain('old');
    });
  });

  describe('appendToEnvList', () => {
    it('creates the key and reports the entry as new', () => {
      expect(appendToEnvList(rootDir, 'SAF_LIST', 'alpha')).toBe(true);
      expect(readEnvValue(rootDir, 'SAF_LIST')).toBe('alpha');
    });

    it('unions new entries and preserves existing ones', () => {
      write('SAF_LIST=alpha, beta\n');
      expect(appendToEnvList(rootDir, 'SAF_LIST', 'gamma')).toBe(true);
      expect(readEnvValue(rootDir, 'SAF_LIST')).toBe('alpha,beta,gamma');
    });

    it('is idempotent: an existing entry returns false and leaves the file alone', () => {
      write('SAF_LIST=alpha,beta\nOTHER=1\n');
      const before = read();
      expect(appendToEnvList(rootDir, 'SAF_LIST', 'beta')).toBe(false);
      expect(read()).toBe(before);
    });

    it('unions against the file value even when process.env differs', () => {
      // Readers of list keys (the adapter's SLACK_INSTANCES loop) parse .env
      // only, so the union must be based on the file, not a stale
      // process.env copy.
      write('SAF_LIST=alpha\n');
      vi.stubEnv('SAF_LIST', 'alpha,from-process-env');
      expect(appendToEnvList(rootDir, 'SAF_LIST', 'beta')).toBe(true);
      expect(read()).toContain('SAF_LIST=alpha,beta');
    });
  });
});
