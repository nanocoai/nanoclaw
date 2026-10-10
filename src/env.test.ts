import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { envValue, readEnvFile } from './env.js';

/**
 * `envValue` is the single-key form of `readEnvFile` — same file, same parser,
 * same rules. These pin that equivalence, because the reason it exists is that
 * a second hand-rolled parser drifted from this one on quoted values.
 */
describe('envValue', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (content: string): void => fs.writeFileSync(path.join(root, '.env'), content);

  it('strips surrounding quotes, exactly as readEnvFile does', () => {
    write('TZ="America/New_York"\nPLAIN=bare\nSINGLE=\'quoted\'\n');
    expect(envValue('TZ', root)).toBe('America/New_York');
    expect(envValue('PLAIN', root)).toBe('bare');
    expect(envValue('SINGLE', root)).toBe('quoted');
    for (const key of ['TZ', 'PLAIN', 'SINGLE']) {
      expect(envValue(key, root)).toBe(readEnvFile([key], root)[key]);
    }
  });

  it('preserves a quoted value that contains spaces', () => {
    write('TEMPLATE_PATH="/opt/my templates"\n');
    expect(envValue('TEMPLATE_PATH', root)).toBe('/opt/my templates');
  });

  it('returns undefined for a missing key, an empty value, and a missing file', () => {
    write('SET=value\nEMPTY=\n# COMMENT=no\n');
    expect(envValue('ABSENT', root)).toBeUndefined();
    expect(envValue('EMPTY', root)).toBeUndefined();
    expect(envValue('COMMENT', root)).toBeUndefined();
    expect(envValue('SET', path.join(root, 'nowhere'))).toBeUndefined();
  });

  it('keeps = inside the value', () => {
    write('TOKEN=abc=def==\n');
    expect(envValue('TOKEN', root)).toBe('abc=def==');
  });
});
