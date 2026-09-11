/**
 * The approved-keys store the host owns (`data/door/keys.json`): keys the
 * operator approved on this machine (with their public keys), fingerprints
 * the account service approved in the browser (mirrored from snapshots),
 * and the pending record of unknown keys that entered the waiting room.
 *
 * Every presented key is admitted to exactly one forced program: an approved
 * fingerprint lands in a sandbox, an unknown one enters the waiting room.
 * The waiting room is the only surface a stranger reaches behind the OpenSSH
 * handshake, so pending records are rate-limited; past the limit the room is
 * refused.
 */
import { createHash } from 'node:crypto';

import { readJson, writePrivate } from '../../community-portal/private-file.js';
import { forcedCommandOption, resolveEntry } from './paths.js';

export interface ApprovedKey {
  fingerprint: string;
  publicKey: string;
  label: string;
  approvedAt: string;
}

export interface PendingKey {
  fingerprint: string;
  publicKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  source?: string;
}

export interface KeyStore {
  version: 1;
  approved: ApprovedKey[];
  pending: PendingKey[];
  /** Fingerprints approved in the browser, as the account service last reported them. */
  mirror?: { fingerprints: string[]; updatedAt: string };
}

export interface ParsedPublicKey {
  type: string;
  base64: string;
  comment: string;
  /** `<type> <base64>` — the two fields the server compares. */
  publicKey: string;
  /** `SHA256:<base64 without padding>` — the server's default fingerprint format. */
  fingerprint: string;
}

/** Pending keys admitted per window before further unknown keys are refused. */
export const PENDING_LIMIT = 10;
export const PENDING_WINDOW_MS = 10 * 60_000;
/** A pending key nobody approved is forgotten after this long. */
export const PENDING_RETENTION_MS = 24 * 60 * 60_000;

const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export function emptyKeyStore(): KeyStore {
  return { version: 1, approved: [], pending: [] };
}

/** Parse one OpenSSH public key line (`<type> <base64> [comment]`) and compute its fingerprint. */
export function parsePublicKey(text: string): ParsedPublicKey {
  const fields = text.trim().split(/\s+/);
  const [type, base64] = fields;
  if (!type || !base64 || !KEY_TYPES.has(type)) {
    throw new Error('expected an OpenSSH public key line: "<type> <base64> [comment]"');
  }
  const blob = Buffer.from(base64, 'base64');
  if (blob.length < 8 || blob.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
    throw new Error('public key is not valid base64');
  }
  const typeLength = blob.readUInt32BE(0);
  if (blob.subarray(4, 4 + typeLength).toString('utf8') !== type) {
    throw new Error('public key blob does not match its declared type');
  }
  return {
    type,
    base64,
    comment: fields.slice(2).join(' '),
    publicKey: `${type} ${base64}`,
    fingerprint: fingerprintOf(blob),
  };
}

export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

export async function readKeyStore(file: string): Promise<KeyStore> {
  const store = await readJson<KeyStore>(file);
  if (!store || store.version !== 1 || !Array.isArray(store.approved) || !Array.isArray(store.pending)) {
    return emptyKeyStore();
  }
  if (store.mirror && !Array.isArray(store.mirror.fingerprints)) delete store.mirror;
  return store;
}

export function writeKeyStore(file: string, store: KeyStore): Promise<void> {
  return writePrivate(file, store);
}

export type Admission = 'approved' | 'pending' | 'refused';

export interface AdmissionResult {
  verdict: Admission;
  store: KeyStore;
  changed: boolean;
}

/**
 * Decide what a presented key is admitted to and record it. Pure over the
 * store value: the caller persists `store` when `changed` is set. The server
 * asks twice per login (a query, then the signed attempt), so an already
 * pending key only refreshes its `lastSeenAt` and never counts twice.
 */
export function admitKey(
  store: KeyStore,
  key: Pick<ParsedPublicKey, 'publicKey' | 'fingerprint'>,
  now: Date = new Date(),
  source?: string,
): AdmissionResult {
  const approved = store.approved.find((k) => k.fingerprint === key.fingerprint);
  if (approved) {
    return { verdict: approved.publicKey === key.publicKey ? 'approved' : 'refused', store, changed: false };
  }
  const nowIso = now.toISOString();
  const pending = store.pending.filter((k) => now.getTime() - Date.parse(k.firstSeenAt) < PENDING_RETENTION_MS);
  const known = pending.find((k) => k.fingerprint === key.fingerprint);
  if (known) {
    known.lastSeenAt = nowIso;
    if (source && !known.source) known.source = source;
    return { verdict: 'pending', store: { ...store, pending }, changed: true };
  }
  const recent = pending.filter((k) => now.getTime() - Date.parse(k.firstSeenAt) < PENDING_WINDOW_MS).length;
  if (recent >= PENDING_LIMIT) {
    return { verdict: 'refused', store: { ...store, pending }, changed: pending.length !== store.pending.length };
  }
  pending.push({
    fingerprint: key.fingerprint,
    publicKey: key.publicKey,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    ...(source ? { source } : {}),
  });
  return { verdict: 'pending', store: { ...store, pending }, changed: true };
}

/**
 * The authorized_keys line the server receives for an admitted key: every
 * option `restrict` implies (no forwarding, no user rc), a PTY, and a forced
 * program that receives the door directory and the fingerprint (the waiting
 * room also gets the key itself, to register it as pending). `undefined`
 * means refuse — print nothing.
 */
export function authorizedKeysLine(
  verdict: Admission,
  key: Pick<ParsedPublicKey, 'publicKey' | 'fingerprint' | 'type' | 'base64'>,
  doorDir: string,
  execPath: string = process.execPath,
): string | undefined {
  if (verdict === 'refused') return undefined;
  const program = resolveEntry(verdict === 'approved' ? 'landing' : 'waiting-room', execPath);
  const args = verdict === 'approved' ? [doorDir, key.fingerprint] : [doorDir, key.fingerprint, key.type, key.base64];
  return `restrict,pty,${forcedCommandOption([...program, ...args])} ${key.publicKey}`;
}

// --- operator verbs over the store ------------------------------------------

export function addApprovedKey(store: KeyStore, key: ParsedPublicKey, label: string, now: Date = new Date()): KeyStore {
  const entry: ApprovedKey = {
    fingerprint: key.fingerprint,
    publicKey: key.publicKey,
    label: label || key.comment || 'terminal',
    approvedAt: now.toISOString(),
  };
  return {
    ...store,
    approved: [...store.approved.filter((k) => k.fingerprint !== key.fingerprint), entry],
    pending: store.pending.filter((k) => k.fingerprint !== key.fingerprint),
  };
}

export function approvePendingKey(
  store: KeyStore,
  fingerprint: string,
  label?: string,
  now: Date = new Date(),
): KeyStore {
  const pending = store.pending.find((k) => k.fingerprint === fingerprint);
  if (!pending) {
    if (store.approved.some((k) => k.fingerprint === fingerprint)) return store;
    throw new Error(`no pending key ${fingerprint} — connect once so it appears, or add its public key directly`);
  }
  return addApprovedKey(
    store,
    { ...parsePublicKey(pending.publicKey), comment: '' },
    label ?? pending.source ?? '',
    now,
  );
}

export function revokeKey(store: KeyStore, fingerprint: string): KeyStore {
  const approved = store.approved.filter((k) => k.fingerprint !== fingerprint);
  const pending = store.pending.filter((k) => k.fingerprint !== fingerprint);
  if (approved.length === store.approved.length && pending.length === store.pending.length) {
    throw new Error(`no key ${fingerprint}`);
  }
  return { ...store, approved, pending };
}

/** Approved on this machine or in the browser. */
export function isApproved(store: KeyStore, fingerprint: string): boolean {
  return (
    store.approved.some((k) => k.fingerprint === fingerprint) ||
    store.mirror?.fingerprints.includes(fingerprint) === true
  );
}
