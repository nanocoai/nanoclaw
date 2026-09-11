/**
 * Who may land — the host-side authority the door's sessions ask.
 *
 * Two sources of approval are honoured: keys the operator approved on this
 * machine (`data/door/keys.json`, with their public keys) and fingerprints
 * the account service approved in the browser, which arrive with every
 * snapshot push through `applyMirror()`. The authority also owns the
 * waiting rooms (capped per machine, pending records rate-limited in the
 * store), the waiters a room releases on approval, and the live sessions
 * registered per fingerprint so a revocation ends them.
 */
import { EventEmitter } from 'node:events';

import {
  addApprovedKey,
  admitKey,
  approvePendingKey,
  emptyKeyStore,
  isApproved,
  parsePublicKey,
  readKeyStore,
  revokeKey as revokeInStore,
  writeKeyStore,
  type ApprovedKey,
  type KeyStore,
  type ParsedPublicKey,
} from './keys.js';
import type { DoorSource } from './target-map.js';

export type AuthorizeStatus = 'approved' | 'unknown' | 'disabled';

export interface PendingRequest {
  fingerprint: string;
  keyType: string;
  /** The key blob (base64) or the full `<type> <base64>` line. */
  publicKey: string;
}

/** Waiting rooms open at once on this machine. */
export const ROOM_LIMIT = 4;
export const ROOM_TTL_MS = 10 * 60_000;

export interface MirrorTerminal {
  enabled?: boolean;
  name?: string;
  previousName?: string;
  keys?: { fingerprint: string }[];
}

export interface MirrorDelta {
  approved: string[];
  revoked: string[];
}

let file: string | undefined;
let store: KeyStore = emptyKeyStore();
const rooms = new Map<string, number>();
const sessions = new Map<string, Set<() => void>>();
const changes = new EventEmitter();
changes.setMaxListeners(0);

export async function initAuthority(keyStoreFile: string): Promise<void> {
  file = keyStoreFile;
  store = await readKeyStore(file);
}

/** Tests only: forget everything in memory. */
export function resetAuthority(): void {
  file = undefined;
  store = emptyKeyStore();
  rooms.clear();
  sessions.clear();
  changes.removeAllListeners();
}

async function persist(): Promise<void> {
  if (file) await writeKeyStore(file, store);
}

export function keyStore(): KeyStore {
  return structuredClone(store);
}

export function isKeyApproved(fingerprint: string): boolean {
  return isApproved(store, fingerprint);
}

export function authorizeStatus(fingerprint: string, enabled: boolean): AuthorizeStatus {
  if (!enabled) return 'disabled';
  return isKeyApproved(fingerprint) ? 'approved' : 'unknown';
}

function pruneRooms(now: number): void {
  for (const [fingerprint, expiresAt] of rooms) if (expiresAt <= now) rooms.delete(fingerprint);
}

/**
 * Open (or refresh) a waiting room for an unknown key. `limit` when the
 * machine already has its share of rooms or the store's pending rate limit
 * is reached; the room then prints its message and ends.
 */
export async function openRoom(
  request: PendingRequest,
  source?: DoorSource,
  now: Date = new Date(),
): Promise<'ok' | 'limit'> {
  pruneRooms(now.getTime());
  if (!rooms.has(request.fingerprint) && rooms.size >= ROOM_LIMIT) return 'limit';
  const publicKey = request.publicKey.includes(' ') ? request.publicKey : `${request.keyType} ${request.publicKey}`;
  const key = parsePublicKey(publicKey);
  const result = admitKey(store, key, now, source?.ip);
  if (result.verdict === 'refused') return 'limit';
  store = result.store;
  if (result.changed) await persist();
  rooms.set(key.fingerprint, now.getTime() + ROOM_TTL_MS);
  return 'ok';
}

/** Resolve true as soon as the fingerprint is approved, false after `waitMs`. */
export function waitForApproval(fingerprint: string, waitMs: number): Promise<boolean> {
  if (isKeyApproved(fingerprint)) return Promise.resolve(true);
  if (waitMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onApproved = (approved: string): void => {
      if (approved !== fingerprint) return;
      clearTimeout(timer);
      changes.off('approved', onApproved);
      resolve(true);
    };
    const timer = setTimeout(() => {
      changes.off('approved', onApproved);
      resolve(false);
    }, waitMs);
    changes.on('approved', onApproved);
  });
}

function released(fingerprint: string): void {
  rooms.delete(fingerprint);
  changes.emit('approved', fingerprint);
}

export async function approveKey(fingerprint: string, label?: string): Promise<ApprovedKey> {
  store = approvePendingKey(store, fingerprint, label);
  await persist();
  released(fingerprint);
  return store.approved.find((k) => k.fingerprint === fingerprint)!;
}

export async function addKey(key: ParsedPublicKey, label: string): Promise<ApprovedKey> {
  store = addApprovedKey(store, key, label);
  await persist();
  released(key.fingerprint);
  return store.approved.find((k) => k.fingerprint === key.fingerprint)!;
}

/** Remove a local approval (a browser approval can only be revoked in the browser) and end its sessions. */
export async function revokeKey(fingerprint: string): Promise<void> {
  const mirrored = store.mirror?.fingerprints.includes(fingerprint) === true;
  const local = store.approved.some((k) => k.fingerprint === fingerprint);
  const pending = store.pending.some((k) => k.fingerprint === fingerprint);
  if (!local && !pending) {
    if (mirrored) throw new Error(`${fingerprint} was approved in the browser — revoke it there`);
    throw new Error(`no key ${fingerprint}`);
  }
  store = revokeInStore(store, fingerprint);
  await persist();
  rooms.delete(fingerprint);
  if (!mirrored) endSessions(fingerprint);
}

/**
 * Apply the account service's view (fingerprints only). Newly approved
 * fingerprints release their waiting rooms; fingerprints that left are
 * revoked here and their live sessions are ended.
 */
export async function applyMirror(terminal: MirrorTerminal | undefined): Promise<MirrorDelta> {
  const next = new Set((terminal?.keys ?? []).map((k) => k.fingerprint));
  const previous = new Set(store.mirror?.fingerprints ?? []);
  const approved = [...next].filter((f) => !previous.has(f));
  const revoked = [...previous].filter((f) => !next.has(f));
  const hadMirror = store.mirror !== undefined;
  store = { ...store, mirror: { fingerprints: [...next], updatedAt: new Date().toISOString() } };
  if (approved.length || revoked.length || !hadMirror) await persist();
  for (const fingerprint of approved) released(fingerprint);
  for (const fingerprint of revoked) {
    if (!store.approved.some((k) => k.fingerprint === fingerprint)) endSessions(fingerprint);
  }
  return { approved, revoked };
}

/** Register a way to end a live session under its key; returns the unregister. */
export function registerSession(fingerprint: string, end: () => void): () => void {
  let ends = sessions.get(fingerprint);
  if (!ends) sessions.set(fingerprint, (ends = new Set()));
  ends.add(end);
  return () => {
    const current = sessions.get(fingerprint);
    current?.delete(end);
    if (current && current.size === 0) sessions.delete(fingerprint);
  };
}

/** End every live session under the fingerprint; returns how many were ended. */
export function endSessions(fingerprint: string): number {
  const ends = sessions.get(fingerprint);
  sessions.delete(fingerprint);
  let ended = 0;
  for (const end of ends ?? []) {
    end();
    ended += 1;
  }
  return ended;
}

export function liveSessions(): number {
  let total = 0;
  for (const ends of sessions.values()) total += ends.size;
  return total;
}

export function openRooms(now: number = Date.now()): number {
  pruneRooms(now);
  return rooms.size;
}
