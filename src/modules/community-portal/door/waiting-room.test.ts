/**
 * The waiting room: what a stranger sees, the approval hand-over, the
 * timeout, the room cap, and a closed connection. Clock and waits are faked.
 */
import { describe, expect, it, vi } from 'vitest';

import type { LandingIo } from './landing.js';
import { runWaitingRoom, WAITING_ROOM_TIMEOUT_MS, waitingRoomBanner, type WaitingRoomDeps } from './waiting-room.js';

const FP = 'SHA256:gOakZC+YL189IEEAB60qLI8r+5H3H4lj4iMh5hlYOSo';
const URL = 'https://example.test/terminals';

/** Each wait round advances the fake clock by `roundMs`. */
function clock(roundMs: number, start = Date.parse('2026-09-11T12:00:00Z')) {
  let now = start;
  return {
    now: () => new Date(now),
    tick: () => {
      now += roundMs;
    },
  };
}

function room(overrides: Partial<WaitingRoomDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: LandingIo = { write: (t) => out.push(t), fail: (t) => err.push(t) };
  const deps: WaitingRoomDeps = {
    fingerprint: FP,
    keyType: 'ssh-ed25519',
    publicKey: 'ssh-ed25519 AAAA',
    source: { ip: '203.0.113.5', port: 4242 },
    approvalUrl: URL,
    io,
    closed: () => false,
    openRoom: vi.fn(async () => 'ok' as const),
    pending: vi.fn(async () => ({ code: 'ABCD-EFGH', url: `${URL}?approve=ABCD-EFGH`, expiresAt: 'x' })),
    waitForApproval: vi.fn(async () => false),
    pollMs: 25_000,
    ...overrides,
  };
  return { deps, out, err };
}

describe('waitingRoomBanner', () => {
  it('shows the fingerprint, the source, the time, the code, the approval page and the CLI alternative', () => {
    const text = waitingRoomBanner(FP, '203.0.113.5', new Date('2026-09-11T12:00:00Z'), URL, 'ABCD-EFGH');
    expect(text).toContain('not approved');
    expect(text).toContain(`key    ${FP}`);
    expect(text).toContain('from   203.0.113.5');
    expect(text).toContain('at     2026-09-11T12:00:00.000Z');
    expect(text).toContain('code   ABCD-EFGH');
    expect(text).toContain(URL);
    expect(text).toContain(`ncl sandboxes remote keys approve ${FP}`);
    expect(waitingRoomBanner(FP, 'remote', new Date(), URL)).not.toContain('code   ');
  });
});

describe('runWaitingRoom', () => {
  it('registers the key, prints the banner with the service code, waits, and continues once approved', async () => {
    const c = clock(25_000);
    let rounds = 0;
    const r = room({
      now: c.now,
      waitForApproval: vi.fn(async () => {
        c.tick();
        return ++rounds >= 3;
      }),
    });
    expect(await runWaitingRoom(r.deps)).toBe(true);
    expect(r.deps.openRoom).toHaveBeenCalledWith(
      { fingerprint: FP, keyType: 'ssh-ed25519', publicKey: 'ssh-ed25519 AAAA' },
      { ip: '203.0.113.5', port: 4242 },
    );
    expect(r.deps.pending).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: FP, source: { ip: '203.0.113.5', port: 4242 }, approvalUrl: URL }),
    );
    const text = r.out.join('');
    expect(text).toContain('from   203.0.113.5');
    expect(text).toContain('code   ABCD-EFGH');
    expect(text).toContain(`${URL}?approve=ABCD-EFGH`);
    expect(text).toContain('Approved. Connecting');
    expect(rounds).toBe(3);
  });

  it('gives up after the timeout', async () => {
    const c = clock(25_000);
    let rounds = 0;
    const r = room({
      now: c.now,
      waitForApproval: vi.fn(async () => {
        c.tick();
        rounds += 1;
        return false;
      }),
    });
    expect(await runWaitingRoom(r.deps)).toBe(false);
    expect(rounds).toBe(WAITING_ROOM_TIMEOUT_MS / 25_000);
    expect(r.out.join('')).toContain('Not approved within 10 minutes');
  });

  it('ends at once when the machine has no room left, and falls back to the configured page when the service fails', async () => {
    const full = room({ openRoom: vi.fn(async () => 'limit' as const) });
    expect(await runWaitingRoom(full.deps)).toBe(false);
    expect(full.err.join('')).toMatch(/Too many pending approvals/);
    expect(full.deps.pending).not.toHaveBeenCalled();

    const c = clock(25_000);
    const offline = room({
      now: c.now,
      pending: vi.fn(async () => Promise.reject(new Error('service down'))),
      waitForApproval: vi.fn(async () => {
        c.tick();
        return true;
      }),
    });
    expect(await runWaitingRoom(offline.deps)).toBe(true);
    expect(offline.out.join('')).toContain(`Approve it in your browser: ${URL}\n`);
    expect(offline.out.join('')).not.toContain('code   ');
  });

  it('stops waiting when the connection is gone', async () => {
    let closed = false;
    const r = room({
      closed: () => closed,
      waitForApproval: vi.fn(async () => {
        closed = true;
        return false;
      }),
    });
    expect(await runWaitingRoom(r.deps)).toBe(false);
    expect(r.deps.waitForApproval).toHaveBeenCalledTimes(1);
  });
});
