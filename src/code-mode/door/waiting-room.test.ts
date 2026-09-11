/**
 * The waiting room: what a stranger sees, the approval → landing hand-over,
 * and the timeout. Clock and sleep are faked; exec is a stub.
 */
import { describe, expect, it, vi } from 'vitest';

import { runWaitingRoom, WAITING_ROOM_POLL_MS, WAITING_ROOM_TIMEOUT_MS, waitingRoomBanner } from './waiting-room.js';

const FP = 'SHA256:gOakZC+YL189IEEAB60qLI8r+5H3H4lj4iMh5hlYOSo';
const URL = 'https://example.test/terminals';

function clock(start = Date.parse('2026-09-11T12:00:00Z')) {
  let now = start;
  return {
    now: () => new Date(now),
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
  };
}

describe('waitingRoomBanner', () => {
  it('shows the fingerprint, the source, the time, the approval page and the CLI alternative', () => {
    const text = waitingRoomBanner(FP, '203.0.113.5', new Date('2026-09-11T12:00:00Z'), URL);
    expect(text).toContain('not approved');
    expect(text).toContain(`key    ${FP}`);
    expect(text).toContain('from   203.0.113.5');
    expect(text).toContain('at     2026-09-11T12:00:00.000Z');
    expect(text).toContain(URL);
    expect(text).toContain(`ncl sandboxes remote keys approve ${FP}`);
  });
});

describe('runWaitingRoom', () => {
  it('polls the store every 2 s and execs into the landing once approved', async () => {
    const c = clock();
    const out: string[] = [];
    let polls = 0;
    const exec = vi.fn(() => 42);
    const code = await runWaitingRoom({
      fingerprint: FP,
      source: 'remote',
      approvalUrl: URL,
      ...c,
      isApproved: async () => ++polls >= 3,
      write: (t) => out.push(t),
      exec,
    });
    expect(code).toBe(42);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(polls).toBe(3);
    expect(c.sleep).toHaveBeenCalledTimes(2);
    expect(c.sleep).toHaveBeenCalledWith(WAITING_ROOM_POLL_MS);
    expect(out.join('')).toContain('Approved. Connecting');
  });

  it('gives up after the timeout with exit 1 and never execs', async () => {
    const c = clock();
    const out: string[] = [];
    const exec = vi.fn(() => 0);
    const code = await runWaitingRoom({
      fingerprint: FP,
      source: 'remote',
      approvalUrl: URL,
      ...c,
      isApproved: async () => false,
      write: (t) => out.push(t),
      exec,
    });
    expect(code).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(c.sleep).toHaveBeenCalledTimes(WAITING_ROOM_TIMEOUT_MS / WAITING_ROOM_POLL_MS);
    expect(out.join('')).toContain('Not approved within 10 minutes');
  });
});
