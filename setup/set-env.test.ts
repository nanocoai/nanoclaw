import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEnvFile } from '../src/env.js';
import { upsertEnvVars } from './set-env.js';

let root: string;
const cwd = process.cwd();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-write-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  expect(process.cwd()).toBe(cwd);
});

describe('atomic configuration writes', () => {
  it('replaces duplicate and whitespace assignments the host reader accepts, preserving unrelated content and mode', () => {
    fs.writeFileSync(path.join(root, '.env'), '# keep\nTOKEN=old\nUNRELATED="literal"\n TOKEN = older\nTOKEN=\n', {
      mode: 0o640,
    });
    expect([...upsertEnvVars({ TOKEN: 'new', URL: 'https://selected.test' })]).toEqual(['TOKEN']);
    expect(readEnvFile(['TOKEN', 'URL', 'UNRELATED'], root)).toEqual({
      TOKEN: 'new',
      URL: 'https://selected.test',
      UNRELATED: 'literal',
    });
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(
      '# keep\nTOKEN=new\nUNRELATED="literal"\nURL=https://selected.test\n',
    );
    expect(fs.statSync(path.join(root, '.env')).mode & 0o777).toBe(0o640);
  });

  it.each(['writeFileSync', 'renameSync'] as const)(
    'keeps the old file on %s failure and removes temporary files',
    (operation) => {
      const file = path.join(root, '.env');
      fs.writeFileSync(file, 'URL=old\nTOKEN=old\n');
      vi.spyOn(fs, operation).mockImplementationOnce(() => {
        throw new Error('disk failure');
      });
      expect(() => upsertEnvVars({ URL: 'new', TOKEN: 'new' })).toThrow('disk failure');
      expect(fs.readFileSync(file, 'utf8')).toBe('URL=old\nTOKEN=old\n');
      expect(fs.readdirSync(root)).toEqual(['.env']);
    },
  );

  it('creates a private file and rejects newline injection before writing', () => {
    expect(() => upsertEnvVars({ TOKEN: 'new\nOTHER=bad' })).toThrow('multiline');
    expect(fs.readdirSync(root)).toEqual([]);
    upsertEnvVars({ TOKEN: 'new' });
    expect(fs.statSync(path.join(root, '.env')).mode & 0o777).toBe(0o600);
  });
});
