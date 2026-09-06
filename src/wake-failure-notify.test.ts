/**
 * Wake-failure notifier (#2902): a channel-accepted message whose container
 * can never spawn used to fail into logs only — the user saw silence. The
 * notifier must (1) stay quiet through transient blips, (2) send one
 * rate-limited notice per session during a persistent outage, (3) re-arm
 * after a successful wake, and (4) never throw into the wake path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(),
}));
vi.mock('./delivery.js', () => ({
  getDeliveryAdapter: vi.fn(),
}));

import { getMessagingGroup } from './db/messaging-groups.js';
import { getDeliveryAdapter } from './delivery.js';
import type { Session } from './types.js';
import {
  NOTIFY_AFTER_FAILURES,
  RENOTIFY_INTERVAL_MS,
  WAKE_FAILURE_NOTICE,
  _resetWakeFailuresForTesting,
  clearWakeFailures,
  notifyWakeFailure,
  recordWakeFailure,
} from './wake-failure-notify.js';

const session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: null,
} as Session;

beforeEach(() => {
  _resetWakeFailuresForTesting();
  vi.mocked(getMessagingGroup).mockResolvedValue({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:42',
    instance: 'telegram',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: '2026-01-01T00:00:00.000Z',
  } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('recordWakeFailure', () => {
  const T0 = Date.parse('2026-08-01T00:00:00.000Z');

  it('stays silent below the consecutive-failure threshold', () => {
    for (let i = 1; i < NOTIFY_AFTER_FAILURES; i++) {
      expect(recordWakeFailure('s1', T0 + i)).toBe(false);
    }
    expect(recordWakeFailure('s1', T0 + NOTIFY_AFTER_FAILURES)).toBe(true);
  });

  it('rate-limits: no second notice inside the renotify interval, one after it', () => {
    for (let i = 0; i < NOTIFY_AFTER_FAILURES; i++) recordWakeFailure('s1', T0);
    // Sweep keeps failing every minute — silent.
    expect(recordWakeFailure('s1', T0 + 60_000)).toBe(false);
    expect(recordWakeFailure('s1', T0 + RENOTIFY_INTERVAL_MS - 1)).toBe(false);
    // Interval elapsed — one more notice.
    expect(recordWakeFailure('s1', T0 + RENOTIFY_INTERVAL_MS + 1)).toBe(true);
    expect(recordWakeFailure('s1', T0 + RENOTIFY_INTERVAL_MS + 2)).toBe(false);
  });

  it('a successful wake resets the streak and re-arms the notifier', () => {
    for (let i = 0; i < NOTIFY_AFTER_FAILURES; i++) recordWakeFailure('s1', T0);
    clearWakeFailures('s1');
    // Fresh outage: threshold applies again from zero.
    expect(recordWakeFailure('s1', T0 + 1)).toBe(false);
    expect(recordWakeFailure('s1', T0 + 2)).toBe(false);
    expect(recordWakeFailure('s1', T0 + 3)).toBe(true);
  });

  it('tracks sessions independently', () => {
    for (let i = 0; i < NOTIFY_AFTER_FAILURES; i++) recordWakeFailure('s1', T0);
    expect(recordWakeFailure('s2', T0)).toBe(false);
  });
});

describe('notifyWakeFailure', () => {
  it('delivers the notice to the originating channel', async () => {
    const deliver = vi.fn().mockResolvedValue('pm-1');
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as never);

    await notifyWakeFailure(session);

    expect(deliver).toHaveBeenCalledWith(
      'telegram',
      'telegram:42',
      null,
      'chat',
      JSON.stringify({ text: WAKE_FAILURE_NOTICE }),
      undefined,
      'telegram',
    );
  });

  it('skips sessions with no messaging group (task / agent-to-agent)', async () => {
    const deliver = vi.fn();
    vi.mocked(getDeliveryAdapter).mockReturnValue({ deliver } as never);

    await notifyWakeFailure({ ...session, messaging_group_id: null } as Session);

    expect(deliver).not.toHaveBeenCalled();
  });

  it('never throws when delivery fails (the channel may share the outage)', async () => {
    vi.mocked(getDeliveryAdapter).mockReturnValue({
      deliver: vi.fn().mockRejectedValue(new Error('channel down too')),
    } as never);

    await expect(notifyWakeFailure(session)).resolves.toBeUndefined();
  });

  it('never throws before the delivery adapter is registered', async () => {
    vi.mocked(getDeliveryAdapter).mockReturnValue(null);

    await expect(notifyWakeFailure(session)).resolves.toBeUndefined();
  });
});
