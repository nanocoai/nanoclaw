/**
 * The host-side authority: waiting-room caps and pending records, long-poll
 * release on approval from any source, revocation ending registered
 * sessions, and the browser mirror.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addKey,
  applyMirror,
  approveKey,
  authorizeStatus,
  initAuthority,
  isKeyApproved,
  keyStore,
  killSessions,
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

let kill: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  kill = vi.fn();
  resetAuthority(kill as unknown as (pid: number, signal: NodeJS.Signals) => void);
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

  it('releases a long-poll when the key is approved on this machine', async () => {
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

  it('releases a long-poll when the browser approves it (mirror), and honours mirror fingerprints', async () => {
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
  it('ends registered sessions when a local key is revoked, tolerating gone processes', async () => {
    const key = syntheticKey(4);
    await addKey(key, 'laptop');
    registerSession({ pid: 111, fingerprint: key.fingerprint });
    registerSession({ pid: 222, fingerprint: key.fingerprint, port: 5 });
    kill.mockImplementationOnce(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    await revokeKey(key.fingerprint);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(222, 'SIGHUP');
    expect(isKeyApproved(key.fingerprint)).toBe(false);
    expect(killSessions(key.fingerprint)).toBe(0);
    await expect(revokeKey(key.fingerprint)).rejects.toThrow(/no key/);
  });

  it('ends sessions of a fingerprint the browser revoked', async () => {
    const a = syntheticKey(5);
    const b = syntheticKey(6);
    await applyMirror({ keys: [{ fingerprint: a.fingerprint }, { fingerprint: b.fingerprint }] });
    registerSession({ pid: 333, fingerprint: b.fingerprint });
    expect(await applyMirror({ keys: [{ fingerprint: a.fingerprint }] })).toEqual({
      approved: [],
      revoked: [b.fingerprint],
    });
    expect(kill).toHaveBeenCalledWith(333, 'SIGHUP');
    expect(isKeyApproved(b.fingerprint)).toBe(false);
    expect(isKeyApproved(a.fingerprint)).toBe(true);
    // A key also approved here survives a browser revocation.
    await addKey(a, 'local');
    await applyMirror(undefined);
    expect(isKeyApproved(a.fingerprint)).toBe(true);
  });
});
