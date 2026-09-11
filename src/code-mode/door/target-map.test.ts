/**
 * Source-port → target map: in-process register/lookup with TTL, and the
 * same answers served to a forced command over the unix socket.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchTarget } from './target-client.js';
import {
  clearTargets,
  DEFAULT_TARGET_TTL_MS,
  lookupTarget,
  registerTarget,
  startTargetServer,
  stopTargetServer,
  unregisterTarget,
} from './target-map.js';

const SOCKET = `/tmp/nanoclaw-door-tm-${process.pid}.sock`;

beforeEach(() => clearTargets());
afterEach(async () => {
  clearTargets();
  await stopTargetServer();
});

describe('target map', () => {
  it('registers, looks up a copy, and forgets on unregister', () => {
    registerTarget(50001, {
      target: { account: 'alice', sandbox: 'demo' },
      source: { ip: '203.0.113.5', port: 40000 },
      stream: 'abc',
      openedAt: '2026-09-11T12:00:00.000Z',
    });
    const found = lookupTarget(50001);
    expect(found).toEqual({
      target: { account: 'alice', sandbox: 'demo' },
      source: { ip: '203.0.113.5', port: 40000 },
      stream: 'abc',
      openedAt: '2026-09-11T12:00:00.000Z',
    });
    found!.target.sandbox = 'changed';
    expect(lookupTarget(50001)?.target.sandbox).toBe('demo');
    unregisterTarget(50001);
    expect(lookupTarget(50001)).toBeUndefined();
  });

  it('stamps openedAt when the caller does not', () => {
    registerTarget(50004, { target: { account: 'alice' } }, undefined, Date.parse('2026-09-11T12:00:00Z'));
    expect(lookupTarget(50004, Date.parse('2026-09-11T12:00:01Z'))?.openedAt).toBe('2026-09-11T12:00:00.000Z');
  });

  it('expires entries after the TTL so a reused port cannot inherit a stale target', () => {
    const t0 = 1_000_000;
    registerTarget(50002, { target: { account: 'alice' } }, undefined, t0);
    expect(lookupTarget(50002, t0 + DEFAULT_TARGET_TTL_MS - 1)?.target).toEqual({ account: 'alice' });
    expect(lookupTarget(50002, t0 + DEFAULT_TARGET_TTL_MS)).toBeUndefined();
    registerTarget(50003, { target: { account: 'bob' } }, 10, t0);
    expect(lookupTarget(50003, t0 + 10)).toBeUndefined();
  });

  it('refuses nonsense registrations', () => {
    expect(() => registerTarget(0, { target: { account: 'alice' } })).toThrow(/source port/);
    expect(() => registerTarget(70000, { target: { account: 'alice' } })).toThrow(/source port/);
    expect(() => registerTarget(5000, { target: { account: '' } })).toThrow(/account/);
  });

  it('serves lookups over the unix socket to the forced commands', async () => {
    await startTargetServer(SOCKET);
    await startTargetServer(SOCKET); // idempotent
    registerTarget(50010, { target: { account: 'alice' }, source: { ip: '203.0.113.5', port: 1 }, openedAt: 't' });
    expect(await fetchTarget(SOCKET, 50010)).toEqual({
      target: { account: 'alice' },
      source: { ip: '203.0.113.5', port: 1 },
      openedAt: 't',
    });
    expect(await fetchTarget(SOCKET, 50011)).toBeUndefined();
    await expect(fetchTarget(SOCKET, 0)).rejects.toThrow(/400/);
    await stopTargetServer();
    await expect(fetchTarget(SOCKET, 50010)).rejects.toThrow();
  });
});
