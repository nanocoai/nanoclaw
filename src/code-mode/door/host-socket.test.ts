/**
 * The door socket: every route the forced commands use, exercised through
 * the client helpers against faked host-side answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authorize, doorRequest, fetchTarget, postPending, postSession, waitApproval } from './door-client.js';
import { MAX_APPROVAL_WAIT_MS, startHostSocket, stopHostSocket, type HostSocketDeps } from './host-socket.js';
import type { DoorStream } from './target-map.js';

const SOCKET = `/tmp/nanoclaw-door-hs-${process.pid}.sock`;
const STREAM: DoorStream = { target: { account: 'alice' }, source: { ip: '203.0.113.5', port: 1 }, openedAt: 't' };

let deps: HostSocketDeps;

beforeEach(async () => {
  deps = {
    lookupTarget: vi.fn((port: number) => (port === 50010 ? STREAM : undefined)),
    authorize: vi.fn((fingerprint: string) => (fingerprint === 'SHA256:ok' ? 'approved' : 'unknown')),
    pending: vi.fn(async (request) =>
      request.fingerprint === 'SHA256:full'
        ? 'limit'
        : { code: 'ABCD-EFGH', url: 'https://example.test/?approve=ABCD-EFGH', expiresAt: 'x' },
    ),
    waitApproval: vi.fn(async (fingerprint: string) => fingerprint === 'SHA256:ok'),
    registerSession: vi.fn(),
  };
  await startHostSocket(SOCKET, deps);
});

afterEach(async () => {
  await stopHostSocket();
});

describe('door socket', () => {
  it('answers target lookups', async () => {
    await startHostSocket(SOCKET, deps); // idempotent
    expect(await fetchTarget(SOCKET, 50010)).toEqual(STREAM);
    expect(await fetchTarget(SOCKET, 50011)).toBeUndefined();
    await expect(fetchTarget(SOCKET, 0)).rejects.toThrow(/400/);
  });

  it('answers authorize', async () => {
    expect(await authorize(SOCKET, 'SHA256:ok')).toBe('approved');
    expect(await authorize(SOCKET, 'SHA256:new')).toBe('unknown');
    expect((await doorRequest(SOCKET, 'GET', '/authorize')).status).toBe(400);
  });

  it('registers pending keys and relays the limit', async () => {
    const request = { fingerprint: 'SHA256:new', keyType: 'ssh-ed25519', publicKey: 'AAAA', port: 50010 };
    expect(await postPending(SOCKET, request)).toEqual({
      code: 'ABCD-EFGH',
      url: 'https://example.test/?approve=ABCD-EFGH',
      expiresAt: 'x',
    });
    expect(deps.pending).toHaveBeenCalledWith(request);
    expect(await postPending(SOCKET, { ...request, fingerprint: 'SHA256:full' })).toBe('limit');
    expect((await doorRequest(SOCKET, 'POST', '/pending', { fingerprint: 1 })).status).toBe(400);
    expect((await doorRequest(SOCKET, 'POST', '/pending', 'x'.repeat(20_000))).status).toBe(413);
  });

  it('long-polls approval with the wait clamped to the host maximum', async () => {
    expect(await waitApproval(SOCKET, 'SHA256:ok', 60)).toBe(true);
    expect(deps.waitApproval).toHaveBeenLastCalledWith('SHA256:ok', MAX_APPROVAL_WAIT_MS);
    expect(await waitApproval(SOCKET, 'SHA256:new', 2)).toBe(false);
    expect(deps.waitApproval).toHaveBeenLastCalledWith('SHA256:new', 2000);
  });

  it('registers landing sessions and refuses bad bodies', async () => {
    await postSession(SOCKET, { pid: 4242, fingerprint: 'SHA256:ok', port: 50010 });
    expect(deps.registerSession).toHaveBeenCalledWith({ pid: 4242, fingerprint: 'SHA256:ok', port: 50010 });
    expect((await doorRequest(SOCKET, 'POST', '/session', { pid: 'x', fingerprint: 'f' })).status).toBe(400);
    expect((await doorRequest(SOCKET, 'GET', '/nope')).status).toBe(404);
  });

  it('is gone after stop', async () => {
    await stopHostSocket();
    await expect(authorize(SOCKET, 'SHA256:ok')).rejects.toThrow();
  });
});
