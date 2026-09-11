/**
 * The AuthorizedKeysCommand end to end over a real store file: approved
 * keys get the landing line, unknown keys get the waiting-room line and are
 * recorded, and the rate limit makes the server refuse.
 */
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuthorizedKeys } from './authorized-keys.js';
import { addApprovedKey, emptyKeyStore, parsePublicKey, PENDING_LIMIT, readKeyStore, writeKeyStore } from './keys.js';
import { doorFiles } from './paths.js';

const DIR = `/tmp/nanoclaw-door-ak-${process.pid}`;
const files = doorFiles(DIR);
const key = parsePublicKey(
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJcU4MBsyv98bPT4z2Ymq9wLqo52QUi0MKqgu7k5gfGV vector@test',
);
const args = (type: string, base64: string): string[] => [DIR, 'SHA256:ignored', type, base64];

function syntheticBase64(index: number): string {
  const type = Buffer.from('ssh-ed25519');
  return Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, index),
  ]).toString('base64');
}

beforeEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
});
afterEach(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('runAuthorizedKeys', () => {
  it('prints the landing line for an approved key without touching the store', async () => {
    await writeKeyStore(files.keyStore, addApprovedKey(emptyKeyStore(), key, 'laptop'));
    const before = fs.statSync(files.keyStore).mtimeMs;
    const out: string[] = [];
    expect(await runAuthorizedKeys(args(key.type, key.base64), (l) => out.push(l))).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^restrict,pty,command=".*landing.*" ssh-ed25519 /);
    expect(fs.statSync(files.keyStore).mtimeMs).toBe(before);
  });

  it('prints the waiting-room line for an unknown key and records it as pending (recomputing the fingerprint)', async () => {
    const out: string[] = [];
    expect(await runAuthorizedKeys(args(key.type, key.base64), (l) => out.push(l))).toBe(0);
    expect(out[0]).toContain('waiting-room');
    expect(out[0]).toContain(`'${key.fingerprint}'`);
    const store = await readKeyStore(files.keyStore);
    expect(store.pending.map((k) => k.fingerprint)).toEqual([key.fingerprint]);
    expect((fs.statSync(files.keyStore).mode & 0o777).toString(8)).toBe('600');
  });

  it('prints nothing once the pending limit is reached', async () => {
    for (let i = 1; i <= PENDING_LIMIT; i++) {
      const out: string[] = [];
      await runAuthorizedKeys(args('ssh-ed25519', syntheticBase64(i)), (l) => out.push(l));
      expect(out).toHaveLength(1);
    }
    const out: string[] = [];
    expect(await runAuthorizedKeys(args('ssh-ed25519', syntheticBase64(PENDING_LIMIT + 1)), (l) => out.push(l))).toBe(
      0,
    );
    expect(out).toEqual([]);
  });

  it('exits non-zero for missing arguments or a key it cannot parse', async () => {
    expect(await runAuthorizedKeys([DIR], () => {})).toBe(2);
    expect(await runAuthorizedKeys(args('ssh-ed25519', '***'), () => {})).toBe(1);
  });
});
