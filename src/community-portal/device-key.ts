import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isErrno, portalError } from './errors.js';

/**
 * The host's device key: one ECDSA P-256 key per machine, kept at
 * ~/.config/nanoclaw/device-key.json in the remote-access module's file schema
 * ({ v: 1, pkcs8_b64, created_at }, mode 0600). It signs the device proof
 * (`x-nc-device-proof`) that accompanies device registration and cell-ticket
 * requests, and nothing else; the private key never leaves this machine.
 *
 * A read failure is not "no key". An unreadable or corrupt file raises an
 * error instead of generating a second identity for the install.
 */
export const DEVICE_PROOF_HEADER = 'x-nc-device-proof';
export const DEVICE_KEY_FILE_RELPATH = path.join('.config', 'nanoclaw', 'device-key.json');
/** A proof is accepted when its `ts` is within this many seconds of the verifier's clock. */
export const PROOF_MAX_SKEW_SECONDS = 60;
const PROOF_SIGNING_PREFIX = 'nanoclaw-host-grant-v1';
const NONCE_PATTERN = /^[\w-]{16,80}$/;

export interface DevicePublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface DeviceKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** First 16 chars of base64url(sha256(SPKI DER)): the proof header's `kid`. */
  fingerprint: string;
  /** The public key as sent to the portal: `{ kty, crv, x, y }` and nothing else. */
  publicKeyJwk: DevicePublicJwk;
  createdAt?: string;
}

export interface DeviceProof {
  kid: string;
  ts: number;
  nonce: string;
  sig: string;
}

export type ProofVerdict =
  | { valid: true; proof: DeviceProof }
  | { valid: false; reason: 'malformed' | 'stale' | 'nonce' | 'kid' | 'signature' };

export interface DeviceKeyOptions {
  homeDir?: string;
  /** Explicit key file path; overrides `homeDir`. */
  file?: string;
}

export function deviceKeyFile(homeDir = os.homedir()): string {
  return path.join(homeDir, DEVICE_KEY_FILE_RELPATH);
}

/** First 16 chars of base64url(sha256(SPKI DER)). */
export function deviceKeyFingerprint(spki: Uint8Array): string {
  return createHash('sha256').update(spki).digest('base64url').slice(0, 16);
}

/** 22-char base64url of 16 random bytes. */
export function makeProofNonce(random: (bytes: number) => Buffer = randomBytes): string {
  return random(16).toString('base64url');
}

export function proofSigningInput(ts: number, nonce: string): Buffer {
  return Buffer.from(`${PROOF_SIGNING_PREFIX}\n${Math.floor(ts)}\n${nonce}`, 'utf-8');
}

/**
 * The `x-nc-device-proof` value:
 *   v1;kid=<fingerprint>;ts=<epoch seconds>;nonce=<22-char base64url>;sig=<base64url ES256, IEEE P1363>
 * over the exact bytes "nanoclaw-host-grant-v1\n" + ts + "\n" + nonce.
 */
export function signProof(key: DeviceKey, opts: { ts: number; nonce: string }): string {
  const ts = Math.floor(opts.ts);
  const sig = sign('sha256', proofSigningInput(ts, opts.nonce), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `v1;kid=${key.fingerprint};ts=${ts};nonce=${opts.nonce};sig=${sig.toString('base64url')}`;
}

/** A fresh proof for the current moment. */
export function deviceProof(key: DeviceKey, now: () => number = Date.now): string {
  return signProof(key, { ts: Math.floor(now() / 1000), nonce: makeProofNonce() });
}

export function parseDeviceProof(value: string): DeviceProof | null {
  const match = /^v1;kid=([\w-]{16});ts=(\d{1,12});nonce=([\w-]{16,80});sig=([\w-]{86})$/.exec(value);
  if (!match) return null;
  return { kid: match[1], ts: Number(match[2]), nonce: match[3], sig: match[4] };
}

/**
 * The verifier's side of the proof, as the portal checks it: fresh within
 * ±60 s, a well-formed nonce, `kid` equal to the key's fingerprint, and a
 * signature that verifies under that key. Nonce single-use is the server's.
 */
export function verifyDeviceProof(
  value: string,
  publicKey: DevicePublicJwk | KeyObject,
  { now = Date.now(), maxSkewSeconds = PROOF_MAX_SKEW_SECONDS }: { now?: number; maxSkewSeconds?: number } = {},
): ProofVerdict {
  const proof = parseDeviceProof(value);
  if (!proof) return { valid: false, reason: 'malformed' };
  if (Math.abs(proof.ts - Math.floor(now / 1000)) > maxSkewSeconds) return { valid: false, reason: 'stale' };
  if (!NONCE_PATTERN.test(proof.nonce)) return { valid: false, reason: 'nonce' };
  const key = 'x' in publicKey ? createPublicKey({ key: publicKey as JsonWebKey, format: 'jwk' }) : publicKey;
  if (deviceKeyFingerprint(key.export({ format: 'der', type: 'spki' })) !== proof.kid)
    return { valid: false, reason: 'kid' };
  const ok = verify(
    'sha256',
    proofSigningInput(proof.ts, proof.nonce),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(proof.sig, 'base64url'),
  );
  return ok ? { valid: true, proof } : { valid: false, reason: 'signature' };
}

/** Materialize a DeviceKey from PKCS#8 DER. Throws on anything but P-256. */
export function deviceKeyFromPkcs8(pkcs8: Buffer, createdAt?: string): DeviceKey {
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'ec') throw new Error('device key is not an EC key');
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: 'jwk' }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('device key is not P-256');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    publicKey,
    fingerprint: deviceKeyFingerprint(spki),
    publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    createdAt,
  };
}

function unreadable(file: string, cause: unknown): Error {
  return Object.assign(
    new Error(`The device key at ${file} could not be read. Fix or remove it, then run the portal setup step again.`, {
      cause,
    }),
    { code: 'device_key_unreadable' },
  );
}

/**
 * The stored device key, or null when the file does not exist. Any other
 * outcome (unreadable, malformed, not a P-256 key) is an error, never a
 * reason to mint a new key.
 */
export function readDeviceKey({ homeDir, file = deviceKeyFile(homeDir) }: DeviceKeyOptions = {}): DeviceKey | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw unreadable(file, error);
  }
  try {
    const parsed = JSON.parse(text) as { v?: unknown; pkcs8_b64?: unknown; created_at?: unknown } | null;
    if (parsed?.v !== 1 || typeof parsed.pkcs8_b64 !== 'string' || !parsed.pkcs8_b64)
      throw portalError('device key file has an unexpected shape', 'device_key_unreadable');
    return deviceKeyFromPkcs8(
      Buffer.from(parsed.pkcs8_b64, 'base64'),
      typeof parsed.created_at === 'string' ? parsed.created_at : undefined,
    );
  } catch (error) {
    throw unreadable(file, error);
  }
}

/** The device key, generated and stored (0600) on first use. */
export function ensureDeviceKey({ homeDir, file = deviceKeyFile(homeDir) }: DeviceKeyOptions = {}): DeviceKey {
  const existing = readDeviceKey({ file });
  if (existing) return existing;
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const createdAt = new Date().toISOString();
  const record = { v: 1 as const, pkcs8_b64: pkcs8.toString('base64'), created_at: createdAt };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('base64url')}.tmp`;
  writeFileSync(temp, JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(temp, file);
  return deviceKeyFromPkcs8(pkcs8, createdAt);
}
