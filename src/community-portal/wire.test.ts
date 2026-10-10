import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deviceKeyFingerprint,
  deviceKeyFromPkcs8,
  parseDeviceProof,
  proofSigningInput,
  signProof,
  verifyDeviceProof,
  type DevicePublicJwk,
} from './device-key.js';

/**
 * wire-vectors.json was produced by running the remote-access module's
 * signProof() (the reference implementation of the device proof) over a
 * throwaway key. These tests pin this client to that format: fingerprint
 * derivation, the signing input bytes, the header layout, and that the
 * verifier the portal mirrors accepts both the reference proofs and ours.
 */
interface ProofCase {
  ts: number;
  nonce: string;
  signingInput: string;
  header: string;
}
interface Vectors {
  proof: { pkcs8_b64: string; publicKey: DevicePublicJwk; fingerprint: string; cases: ProofCase[] };
}
const vectors = JSON.parse(readFileSync(new URL('./wire-vectors.json', import.meta.url), 'utf8')) as Vectors;
const { pkcs8_b64, publicKey, fingerprint, cases } = vectors.proof;
const key = deviceKeyFromPkcs8(Buffer.from(pkcs8_b64, 'base64'));
const publicKeyObject = createPublicKey({ key: publicKey as JsonWebKey, format: 'jwk' });
const HEADER = /^v1;kid=[\w-]{16};ts=\d+;nonce=[\w-]{22};sig=[\w-]{86}$/;

describe('device proof wire contract', () => {
  it('derives the reference fingerprint and public JWK from the pinned key', () => {
    expect(key.fingerprint).toBe(fingerprint);
    expect(key.publicKeyJwk).toEqual(publicKey);
    expect(Object.keys(key.publicKeyJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(deviceKeyFingerprint(publicKeyObject.export({ format: 'der', type: 'spki' }))).toBe(fingerprint);
  });

  it('signs exactly the reference input bytes', () => {
    for (const c of cases) expect(proofSigningInput(c.ts, c.nonce).toString('utf-8')).toBe(c.signingInput);
  });

  it('lays the header out as the reference does', () => {
    for (const c of cases) {
      expect(c.header).toMatch(HEADER);
      expect(parseDeviceProof(c.header)).toMatchObject({ kid: fingerprint, ts: Math.floor(c.ts), nonce: c.nonce });
      const mine = signProof(key, c);
      expect(mine).toMatch(HEADER);
      expect(mine.split(';sig=')[0]).toBe(c.header.split(';sig=')[0]);
    }
  });

  it('accepts the reference-signed proofs, and its own, under the verifier the portal mirrors', () => {
    for (const c of cases) {
      const now = Math.floor(c.ts) * 1000;
      const parsed = parseDeviceProof(c.header);
      expect(parsed).not.toBeNull();
      expect(
        verify(
          'sha256',
          proofSigningInput(c.ts, c.nonce),
          { key: publicKeyObject, dsaEncoding: 'ieee-p1363' },
          Buffer.from(parsed!.sig, 'base64url'),
        ),
      ).toBe(true);
      expect(verifyDeviceProof(c.header, publicKey, { now })).toMatchObject({ valid: true });
      expect(verifyDeviceProof(c.header, publicKeyObject, { now: now + 59_000 })).toMatchObject({ valid: true });
      expect(verifyDeviceProof(signProof(key, c), publicKey, { now })).toMatchObject({ valid: true });
    }
  });

  it('rejects a stale, tampered, foreign or malformed proof', () => {
    const c = cases[0];
    const now = c.ts * 1000;
    expect(verifyDeviceProof(c.header, publicKey, { now: now + 61_000 })).toEqual({ valid: false, reason: 'stale' });
    expect(verifyDeviceProof(c.header, publicKey, { now: now - 61_000 })).toEqual({ valid: false, reason: 'stale' });
    const other = c.nonce.endsWith('w') ? `${c.nonce.slice(0, -1)}x` : `${c.nonce.slice(0, -1)}w`;
    expect(verifyDeviceProof(c.header.replace(`nonce=${c.nonce}`, `nonce=${other}`), publicKey, { now })).toEqual({
      valid: false,
      reason: 'signature',
    });
    const foreign = deviceKeyFromPkcs8(
      Buffer.from(
        'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgX64TMuXXyRVW907yOnnIHJKEIMVdACsxj63qlUgl2FGhRANCAAR+90tBU+706xLzUgIBY/LTgBwTS88YbH1tzFQIHpZWshPymySfvOgV80xlGCLGYnu5TV2UD6X/NN9u5ldcufj0',
        'base64',
      ),
    );
    expect(verifyDeviceProof(c.header, foreign.publicKeyJwk, { now })).toEqual({ valid: false, reason: 'kid' });
    expect(verifyDeviceProof(signProof(foreign, c), publicKey, { now })).toEqual({ valid: false, reason: 'kid' });
    expect(verifyDeviceProof(c.header.replace('v1;', 'v2;'), publicKey, { now })).toEqual({
      valid: false,
      reason: 'malformed',
    });
    expect(verifyDeviceProof('', publicKey, { now })).toEqual({ valid: false, reason: 'malformed' });
  });
});
