/**
 * The host key: generated once in-process, reused afterwards, readable when
 * an earlier build made it with ssh-keygen, fingerprinted like ssh-keygen.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureHostKey } from './host-key.js';
import { parsePublicKey } from './keys.js';
import { doorFiles } from './paths.js';

const DIR = `/tmp/nanoclaw-door-hk-${process.pid}`;
const files = doorFiles(DIR);

const hasKeygen = (() => {
  try {
    execFileSync('which', ['ssh-keygen'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
})();

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});
afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('ensureHostKey', () => {
  it('generates an ed25519 pair once (0600) and reuses it', async () => {
    const first = await ensureHostKey(files);
    expect(first.type).toBe('ssh-ed25519');
    expect(first.publicKey).toMatch(/^ssh-ed25519 AAAA/);
    expect(first.fingerprint).toMatch(/^SHA256:/);
    expect(first.privateKey).toContain('PRIVATE KEY');
    expect((fs.statSync(files.hostKey).mode & 0o777).toString(8)).toBe('600');
    expect(fs.readFileSync(files.hostKeyPublic, 'utf8')).toContain(first.publicKey);
    expect(parsePublicKey(first.publicKey).fingerprint).toBe(first.fingerprint);
    const again = await ensureHostKey(files);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(again.privateKey).toBe(first.privateKey);
  });

  it.skipIf(!hasKeygen)('loads a key ssh-keygen generated and agrees with ssh-keygen -lf', async () => {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'earlier', '-f', files.hostKey]);
    const key = await ensureHostKey(files);
    const printed = execFileSync('ssh-keygen', ['-lf', files.hostKeyPublic], { encoding: 'utf8' }).split(' ')[1];
    expect(key.fingerprint).toBe(printed);
    expect(fs.readFileSync(files.hostKeyPublic, 'utf8')).toContain(key.publicKey);
  });
});
