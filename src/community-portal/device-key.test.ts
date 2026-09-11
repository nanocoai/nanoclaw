import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEVICE_KEY_FILE_RELPATH,
  deviceKeyFile,
  deviceProof,
  ensureDeviceKey,
  makeProofNonce,
  readDeviceKey,
  verifyDeviceProof,
} from './device-key.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'nc-device-key-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('device key file', () => {
  it('generates one P-256 key per machine in the remote-access file schema, mode 0600, and reuses it', async () => {
    const file = deviceKeyFile(home);
    expect(file).toBe(path.join(home, DEVICE_KEY_FILE_RELPATH));
    expect(readDeviceKey({ homeDir: home })).toBeNull();
    const key = ensureDeviceKey({ homeDir: home });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['created_at', 'pkcs8_b64', 'v']);
    expect(record.v).toBe(1);
    expect(record.pkcs8_b64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Date.parse(String(record.created_at))).toBeGreaterThan(0);
    expect(key.publicKeyJwk).toEqual({ kty: 'EC', crv: 'P-256', x: expect.any(String), y: expect.any(String) });
    expect(key.fingerprint).toMatch(/^[\w-]{16}$/);
    expect(key.createdAt).toBe(record.created_at);
    expect(ensureDeviceKey({ homeDir: home }).fingerprint).toBe(key.fingerprint);
    expect(readDeviceKey({ homeDir: home })?.fingerprint).toBe(key.fingerprint);
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify(record) + '\n');
  });

  it('treats an unreadable or corrupt file as an error, never as a reason to mint a new key', async () => {
    const file = deviceKeyFile(home);
    await mkdir(file, { recursive: true });
    expect(() => readDeviceKey({ homeDir: home })).toThrow(expect.objectContaining({ code: 'device_key_unreadable' }));
    expect(() => ensureDeviceKey({ homeDir: home })).toThrow(
      expect.objectContaining({ code: 'device_key_unreadable' }),
    );
    await rm(file, { recursive: true });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    for (const content of [
      'not json',
      '{"v":2,"pkcs8_b64":"AAAA"}',
      '{"v":1}',
      '{"v":1,"pkcs8_b64":""}',
      '{"v":1,"pkcs8_b64":"bm90IGEga2V5"}',
      JSON.stringify({ v: 1, pkcs8_b64: rsa }),
    ]) {
      await writeFile(file, content, { mode: 0o600 });
      expect(() => readDeviceKey({ homeDir: home })).toThrow(
        expect.objectContaining({ code: 'device_key_unreadable' }),
      );
      expect(() => ensureDeviceKey({ homeDir: home })).toThrow(
        expect.objectContaining({ code: 'device_key_unreadable' }),
      );
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });

  it('honours an explicit file path', async () => {
    const file = path.join(home, 'elsewhere', 'key.json');
    const key = ensureDeviceKey({ file });
    expect(readDeviceKey({ file })?.fingerprint).toBe(key.fingerprint);
    expect(readDeviceKey({ homeDir: home })).toBeNull();
  });
});

describe('device proof', () => {
  it('produces a fresh, well-formed header that verifies now and not a minute later', () => {
    const key = ensureDeviceKey({ homeDir: home });
    const now = 1_788_825_600_000;
    const header = deviceProof(key, () => now + 900);
    expect(header).toMatch(/^v1;kid=[\w-]{16};ts=1788825600;nonce=[\w-]{22};sig=[\w-]{86}$/);
    expect(header).toContain(`kid=${key.fingerprint};`);
    expect(verifyDeviceProof(header, key.publicKeyJwk, { now })).toMatchObject({ valid: true });
    expect(verifyDeviceProof(header, key.publicKeyJwk, { now: now + 60_999 })).toMatchObject({ valid: true });
    expect(verifyDeviceProof(header, key.publicKeyJwk, { now: now + 61_000 })).toEqual({
      valid: false,
      reason: 'stale',
    });
    expect(deviceProof(key, () => now)).not.toBe(header);
  });

  it('nonces are 22 base64url characters of 16 bytes', () => {
    expect(makeProofNonce((n) => Buffer.alloc(n, 0xab))).toBe(Buffer.alloc(16, 0xab).toString('base64url'));
    const nonce = makeProofNonce();
    expect(nonce).toMatch(/^[\w-]{22}$/);
    expect(makeProofNonce()).not.toBe(nonce);
  });
});
