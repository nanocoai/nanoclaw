/**
 * Typing-refresh tests: instance forwarding and per-channel cadence.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the interval tick (period derived from the adapter's typingTimeoutMs), and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import fs from 'fs';

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import { setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter(timeouts: Record<string, number> = {}) {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
    typingTimeoutMs: (channelType) => timeouts[channelType],
  });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
      instance: 'slack-tester',
    });
  });

  it('interval ticks inside the grace window pass the stored entry instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Two 4s ticks — well inside the 15s grace window, so they fire
    // unconditionally (no heartbeat file needed) from the stored entry.
    await vi.advanceTimersByTimeAsync(8_500);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) {
      expect(c.instance).toBe('slack-tester');
      expect(c.threadId).toBe('T1');
    }
  });

  it('re-trigger on an active session passes (and stores) the new instance', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', null, 'slack-worker');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].instance).toBe('slack-worker');

    // And the stored entry was updated — subsequent interval ticks carry it.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1].instance).toBe('slack-worker');
  });

  it('re-trigger with a changed address updates the whole entry — interval ticks stay self-consistent', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      channelType: 'telegram',
      platformId: 'tg:99',
      threadId: null,
      instance: 'telegram',
    });

    // Interval ticks fire from the stored entry — all four fields must
    // have moved together.
    calls.length = 0;
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) {
      expect(c).toEqual({
        channelType: 'telegram',
        platformId: 'tg:99',
        threadId: null,
        instance: 'telegram',
      });
    }
  });
});

describe('startTypingRefresh: per-channel cadence', () => {
  beforeEach(() => {
    // Past the 15 s grace window the refresher only keeps going while the
    // heartbeat is fresh; hold it fresh for the whole window.
    vi.spyOn(fs, 'statSync').mockImplementation(() => ({ mtimeMs: Date.now() }) as fs.Stats);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('re-fires 20% before the adapter-declared timeout expires', async () => {
    const calls = captureAdapter({ 'whatsapp-cloud': 25_000 });
    startTypingRefresh('sess-1', 'ag-1', 'whatsapp-cloud', 'wa:1', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3); // 25 s timeout -> every 20 s
  });

  it('re-fires every 4 s when the adapter declares nothing (5 s default timeout)', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:1', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(15);
  });

  it('re-trigger from a channel with a different timeout switches the cadence', async () => {
    const calls = captureAdapter({ 'whatsapp-cloud': 25_000 });
    startTypingRefresh('sess-1', 'ag-1', 'telegram', 'tg:1', null);
    await vi.advanceTimersByTimeAsync(0);

    // Agent-shared session re-triggered from the slower platform: the 4 s
    // refresher must be re-armed at 20 s, not left as-is.
    startTypingRefresh('sess-1', 'ag-1', 'whatsapp-cloud', 'wa:1', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
  });
});
