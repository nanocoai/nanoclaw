/**
 * The waiting room: what a stranger sees, the approval → landing hand-over,
 * and the timeout. The clock and the long-poll are faked; exec is a stub.
 */
import { describe, expect, it, vi } from 'vitest';

import { runWaitingRoom, WAITING_ROOM_TIMEOUT_MS, waitingRoomBanner } from './waiting-room.js';

const FP = 'SHA256:gOakZC+YL189IEEAB60qLI8r+5H3H4lj4iMh5hlYOSo';
const URL = 'https://example.test/?approve=ABCD-EFGH';

/** Each long-poll round advances the fake clock by `roundMs`. */
function clock(roundMs: number, start = Date.parse('2026-09-11T12:00:00Z')) {
  let now = start;
  return {
    now: () => new Date(now),
    tick: () => {
      now += roundMs;
    },
  };
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
  it('long-polls the host and execs into the landing once approved', async () => {
    const c = clock(25_000);
    const out: string[] = [];
    let rounds = 0;
    const exec = vi.fn(async () => 42);
    const code = await runWaitingRoom({
      fingerprint: FP,
      source: 'remote',
      approvalUrl: URL,
      code: 'ABCD-EFGH',
      now: c.now,
      waitApproval: async () => {
        c.tick();
        return ++rounds >= 3;
      },
      write: (t) => out.push(t),
      exec,
    });
    expect(code).toBe(42);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(rounds).toBe(3);
    expect(out.join('')).toContain('Approved. Connecting');
  });

  it('gives up after the timeout with exit 1 and never execs', async () => {
    const c = clock(25_000);
    const out: string[] = [];
    const exec = vi.fn(() => 0);
    let rounds = 0;
    const code = await runWaitingRoom({
      fingerprint: FP,
      source: 'remote',
      approvalUrl: URL,
      now: c.now,
      waitApproval: async () => {
        c.tick();
        rounds += 1;
        return false;
      },
      write: (t) => out.push(t),
      exec,
    });
    expect(code).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(rounds).toBe(WAITING_ROOM_TIMEOUT_MS / 25_000);
    expect(out.join('')).toContain('Not approved within 10 minutes');
  });
});
