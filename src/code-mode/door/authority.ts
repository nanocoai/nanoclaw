/**
 * Who may land — the host-side authority the door socket answers from.
 *
 * Two sources of approval are honoured: keys the operator approved on this
 * machine (`data/door/keys.json`, with their public keys) and fingerprints
 * the account service approved in the browser, which arrive with every
 * snapshot push through `applyMirror()`. The authority also owns the
 * waiting rooms (capped per machine, pending records rate-limited in the
 * store), the long-poll waiters a room releases on approval, and the
 * landing sessions registered per fingerprint so a revocation ends them.
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
import type { AuthorizeStatus, PendingRequest, SessionRequest } from './host-socket.js';
import type { DoorSource } from './target-map.js';

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
const sessions = new Map<string, Set<number>>();
const changes = new EventEmitter();
changes.setMaxListeners(0);

let killer: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => process.kill(pid, signal);

export async function initAuthority(keyStoreFile: string): Promise<void> {
  file = keyStoreFile;
  store = await readKeyStore(file);
}

/** Tests only: forget everything in memory. */
export function resetAuthority(kill?: typeof killer): void {
  file = undefined;
  store = emptyKeyStore();
  rooms.clear();
  sessions.clear();
  changes.removeAllListeners();
  killer = kill ?? ((pid, signal) => process.kill(pid, signal));
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
 * is reached; the room then prints its message and exits.
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
  if (!mirrored) killSessions(fingerprint);
}

/**
 * Apply the account service's view (fingerprints only). Newly approved
 * fingerprints release their waiting rooms; fingerprints that left are
 * revoked here and their registered landings are ended.
 */
export async function applyMirror(terminal: MirrorTerminal | undefined): Promise<MirrorDelta> {
  const next = new Set((terminal?.keys ?? []).map((k) => k.fingerprint));
  const previous = new Set(store.mirror?.fingerprints ?? []);
  const approved = [...next].filter((f) => !previous.has(f));
  const revoked = [...previous].filter((f) => !next.has(f));
  store = { ...store, mirror: { fingerprints: [...next], updatedAt: new Date().toISOString() } };
  if (approved.length || revoked.length || !store.mirror) await persist();
  for (const fingerprint of approved) released(fingerprint);
  for (const fingerprint of revoked) {
    if (!store.approved.some((k) => k.fingerprint === fingerprint)) killSessions(fingerprint);
  }
  return { approved, revoked };
}

export function registerSession(request: SessionRequest): void {
  let pids = sessions.get(request.fingerprint);
  if (!pids) sessions.set(request.fingerprint, (pids = new Set()));
  pids.add(request.pid);
}

/** SIGHUP every landing registered under the fingerprint, as the server does when a connection drops. */
export function killSessions(fingerprint: string): number {
  const pids = sessions.get(fingerprint);
  sessions.delete(fingerprint);
  let ended = 0;
  for (const pid of pids ?? []) {
    try {
      killer(pid, 'SIGHUP');
      ended += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return ended;
}

export function openRooms(now: number = Date.now()): number {
  pruneRooms(now);
  return rooms.size;
}
