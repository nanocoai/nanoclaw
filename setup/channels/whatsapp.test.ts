import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selfChatEngagePattern, writeEnvVar } from './whatsapp.js';

describe('selfChatEngagePattern', () => {
  it('matches messages starting with @<name> and nothing else', () => {
    const re = new RegExp(selfChatEngagePattern('Nano'));
    expect(re.test('@Nano what time is it?')).toBe(true);
    expect(re.test('@Nano')).toBe(true);
    expect(re.test('hey @Nano')).toBe(false);
    expect(re.test('grocery list')).toBe(false);
    // \b guard: name must end at a word boundary, not prefix a longer word.
    expect(re.test('@Nanobot hello')).toBe(false);
  });

  it('escapes regex metacharacters in the agent name', () => {
    const re = new RegExp(selfChatEngagePattern('C-3PO (backup)'));
    expect(re.test('@C-3PO (backup) status?')).toBe(true);
    expect(re.test('@C-3PO Xbackup) status?')).toBe(false);
  });

  it('drops the trailing \\b for names ending in non-word characters', () => {
    const pattern = selfChatEngagePattern('Nano!');
    expect(pattern.endsWith('\\b')).toBe(false);
    expect(new RegExp(pattern).test('@Nano! do the thing')).toBe(true);
  });
});

describe('writeEnvVar', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
    envPath = path.join(dir, '.env');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file when missing', () => {
    writeEnvVar('ASSISTANT_NAME', 'Nano', envPath);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('ASSISTANT_NAME=Nano\n');
  });

  it('appends to an existing file, adding a newline if needed', () => {
    fs.writeFileSync(envPath, 'TZ=UTC');
    writeEnvVar('ASSISTANT_HAS_OWN_NUMBER', 'true', envPath);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(
      'TZ=UTC\nASSISTANT_HAS_OWN_NUMBER=true\n',
    );
  });

  it('replaces an existing line in place without touching neighbors', () => {
    fs.writeFileSync(envPath, 'ASSISTANT_NAME=Andy\nTZ=UTC\n');
    writeEnvVar('ASSISTANT_NAME', 'Nano', envPath);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe('ASSISTANT_NAME=Nano\nTZ=UTC\n');
  });

  it('keeps $-sequences in the value literal', () => {
    fs.writeFileSync(envPath, 'ASSISTANT_NAME=Andy\n');
    writeEnvVar('ASSISTANT_NAME', "$& $' $1", envPath);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe("ASSISTANT_NAME=$& $' $1\n");
  });
});
