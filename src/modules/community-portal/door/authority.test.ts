/**
 * The host-side authority: waiting-room caps and pending records, waiters
 * released on approval from any source, revocation ending live sessions,
 * and the browser mirror.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addKey,
  applyMirror,
  approveKey,
  authorizeStatus,
  endSessions,
  initAuthority,
  isKeyApproved,
  keyStore,
  liveSessions,
  openRoom,
  openRooms,
  registerSession,
  resetAuthority,
  revokeKey,
  ROOM_LIMIT,
  ROOM_TTL_MS,
  waitForApproval,
} from './authority.js';
import { parsePublicKey, readKeyStore } from './keys.js';

const DIR = `/tmp/nanoclaw-door-auth-${process.pid}`;
const FILE = path.join(DIR, 'keys.json');
const T0 = new Date('2026-09-11T12:00:00Z');

function syntheticKey(index: number) {
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, index),
  ]);
  const parsed = parsePublicKey(`ssh-ed25519 ${blob.toString('base64')}`);
  return { ...parsed, request: { fingerprint: parsed.fingerprint, keyType: parsed.type, publicKey: parsed.base64 } };
}

beforeEach(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  resetAuthority();
  await initAuthority(FILE);
});

afterEach(() => {
  resetAuthority();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe('waiting rooms', () => {
  it(`opens at most ${ROOM_LIMIT} rooms at once, refreshes a known key, and frees expired rooms`, async () => {
    for (let i = 1; i <= ROOM_LIMIT; i++) {
      expect(await openRoom(syntheticKey(i).request, { ip: '203.0.113.5', port: 1 }, T0)).toBe('ok');
    }
    expect(openRooms(T0.getTime())).toBe(ROOM_LIMIT);
    expect(await openRoom(syntheticKey(ROOM_LIMIT + 1).request, undefined, T0)).toBe('limit');
    expect(await openRoom(syntheticKey(1).request, undefined, new Date(T0.getTime() + 1000))).toBe('ok');
    const later = new Date(T0.getTime() + ROOM_TTL_MS + 1);
    expect(await openRoom(syntheticKey(ROOM_LIMIT + 1).request, undefined, later)).toBe('ok');
    const pending = (await readKeyStore(FILE)).pending;
    expect(pending.map((k) => k.fingerprint)).toContain(syntheticKey(1).fingerprint);
    expect(pending.find((k) => k.fingerprint === syntheticKey(1).fingerprint)?.source).toBe('203.0.113.5');
  });

  it('accepts the full public key line as well as the bare blob', async () => {
    const key = syntheticKey(9);
    expect(await openRoom({ ...key.request, publicKey: key.publicKey }, undefined, T0)).toBe('ok');
    expect(keyStore().pending[0].publicKey).toBe(key.publicKey);
  });
});

describe('concurrent admissions', () => {
  it('two unknown keys admitted at once both land as pending, on disk too', async () => {
    const [a, b] = [syntheticKey(21), syntheticKey(22)];
    const [first, second] = await Promise.all([openRoom(a.request, undefined, T0), openRoom(b.request, undefined, T0)]);
    expect([first, second]).toEqual(['ok', 'ok']);
    const pending = (await readKeyStore(FILE)).pending.map((k) => k.fingerprint).sort();
    expect(pending).toEqual([a.fingerprint, b.fingerprint].sort());
    expect(openRooms(T0.getTime())).toBe(2);
  });
});

describe('approval', () => {
  it('reports unknown / approved / disabled', async () => {
    const key = syntheticKey(1);
    expect(authorizeStatus(key.fingerprint, true)).toBe('unknown');
    expect(authorizeStatus(key.fingerprint, false)).toBe('disabled');
    await addKey(key, 'laptop');
    expect(authorizeStatus(key.fingerprint, true)).toBe('approved');
    expect((await readKeyStore(FILE)).approved[0].label).toBe('laptop');
  });

  it('releases a waiter when the key is approved on this machine', async () => {
    const key = syntheticKey(2);
    await openRoom(key.request, undefined, T0);
    expect(await waitForApproval(key.fingerprint, 50)).toBe(false);
    const waiting = waitForApproval(key.fingerprint, 5000);
    const approved = await approveKey(key.fingerprint, 'phone');
    expect(approved.fingerprint).toBe(key.fingerprint);
    expect(await waiting).toBe(true);
    expect(openRooms(T0.getTime())).toBe(0);
    expect(keyStore().pending).toEqual([]);
    expect(await waitForApproval(key.fingerprint, 0)).toBe(true);
  });

  it('releases a waiter when the browser approves it (mirror), and honours mirror fingerprints', async () => {
    const key = syntheticKey(3);
    const waiting = waitForApproval(key.fingerprint, 5000);
    expect(await applyMirror({ keys: [{ fingerprint: key.fingerprint }] })).toEqual({
      approved: [key.fingerprint],
      revoked: [],
    });
    expect(await waiting).toBe(true);
    expect(isKeyApproved(key.fingerprint)).toBe(true);
    expect((await readKeyStore(FILE)).mirror?.fingerprints).toEqual([key.fingerprint]);
    await expect(revokeKey(key.fingerprint)).rejects.toThrow(/approved in the browser/);
  });
});

describe('revocation', () => {
  it('ends live sessions when a local key is revoked, and forgets unregistered ones', async () => {
    const key = syntheticKey(4);
    await addKey(key, 'laptop');
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerSession(key.fingerprint, first);
    registerSession(key.fingerprint, second);
    expect(liveSessions()).toBe(2);
    unregisterFirst();
    expect(liveSessions()).toBe(1);
    await revokeKey(key.fingerprint);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(isKeyApproved(key.fingerprint)).toBe(false);
    expect(endSessions(key.fingerprint)).toBe(0);
    expect(liveSessions()).toBe(0);
    await expect(revokeKey(key.fingerprint)).rejects.toThrow(/no key/);
  });

  it('ends sessions of a fingerprint the browser revoked', async () => {
    const a = syntheticKey(5);
    const b = syntheticKey(6);
    await applyMirror({ keys: [{ fingerprint: a.fingerprint }, { fingerprint: b.fingerprint }] });
    const end = vi.fn();
    registerSession(b.fingerprint, end);
    expect(await applyMirror({ keys: [{ fingerprint: a.fingerprint }] })).toEqual({
      approved: [],
      revoked: [b.fingerprint],
    });
    expect(end).toHaveBeenCalledTimes(1);
    expect(isKeyApproved(b.fingerprint)).toBe(false);
    expect(isKeyApproved(a.fingerprint)).toBe(true);
    // A key also approved here survives a browser revocation.
    await addKey(a, 'local');
    await applyMirror(undefined);
    expect(isKeyApproved(a.fingerprint)).toBe(true);
  });
});
