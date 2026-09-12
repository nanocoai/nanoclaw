/**
 * Typing-refresh instance forwarding tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import fs from 'fs';
import path from 'path';

import { heartbeatPath } from '../../session-manager.js';
import {
  noteTurnState,
  pauseTypingRefreshAfterDelivery,
  setTypingAdapter,
  startTypingRefresh,
  stopTypingRefresh,
} from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter() {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

/** Adapter that records both set and clear calls. */
function captureSetAndClear() {
  const sets: Call[] = [];
  const clears: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      sets.push({ channelType, platformId, threadId, instance });
    },
    async clearTyping(channelType, platformId, threadId, instance) {
      clears.push({ channelType, platformId, threadId, instance });
    },
  });
  return { sets, clears };
}

/** Write a heartbeat file with an mtime at the current (fake) clock. */
function touchHeartbeat(agentGroupId: string, sessionId: string): void {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  fs.mkdirSync(path.dirname(hbPath), { recursive: true });
  fs.writeFileSync(hbPath, '');
  const seconds = Date.now() / 1000;
  fs.utimesSync(hbPath, seconds, seconds);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  stopTypingRefresh('sess-turn');
  if (fs.existsSync('/tmp/nanoclaw-test-typing'))
    fs.rmSync('/tmp/nanoclaw-test-typing', { recursive: true, force: true });
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

describe('typing follows the runner turn state', () => {
  const SESS = 'sess-turn';
  const AG = 'ag-turn';

  /** Advance past the 15s grace, keeping a working report live throughout. */
  async function advancePastGraceWorking(): Promise<void> {
    for (let elapsed = 0; elapsed < 20_000; elapsed += 4_000) {
      noteTurnState(SESS, { turn: 'working', updatedAtMs: Date.now() });
      await vi.advanceTimersByTimeAsync(4_000);
    }
  }

  it('quiet turn: an idle report with no delivery stops the refresh and clears exactly once', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    await advancePastGraceWorking();
    const setsWhileWorking = sets.length;
    expect(setsWhileWorking).toBeGreaterThan(1); // still refreshing past grace

    // Turn ends without delivering anything.
    noteTurnState(SESS, { turn: 'idle', updatedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(clears).toHaveLength(1);
    expect(clears[0]).toEqual({ channelType: 'slack', platformId: 'C1', threadId: 'T1', instance: 'slack-inst' });

    // No more refreshes and no second clear once the refresher has ended.
    const setsAfterEnd = sets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBe(setsAfterEnd);
    expect(clears).toHaveLength(1);
  });

  it('multi-message turn: two deliveries pause and resume, then a single clear at idle', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await advancePastGraceWorking();

    // First delivery pauses the refresh; ticks inside the pause skip setTyping.
    pauseTypingRefreshAfterDelivery(SESS);
    let before = sets.length;
    noteTurnState(SESS, { turn: 'working', updatedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(8_000); // inside the 10s pause
    expect(sets.length).toBe(before); // no refresh while paused

    // Pause expires; a live working report resumes refreshing.
    noteTurnState(SESS, { turn: 'working', updatedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sets.length).toBeGreaterThan(before);

    // Second delivery pauses again.
    pauseTypingRefreshAfterDelivery(SESS);
    before = sets.length;
    noteTurnState(SESS, { turn: 'working', updatedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sets.length).toBe(before);
    noteTurnState(SESS, { turn: 'working', updatedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sets.length).toBeGreaterThan(before);

    // Turn ends: exactly one clear across the whole turn.
    noteTurnState(SESS, { turn: 'idle', updatedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(clears).toHaveLength(1);
  });

  it('dead runner: a working report that stops advancing clears after it goes stale', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);
    await advancePastGraceWorking();

    // The runner dies: the last working report stops advancing. It stays live
    // for TURN_STALE_MS, then the next tick ends the refresh.
    const setsBeforeDeath = sets.length;
    noteTurnState(SESS, { turn: 'working', updatedAtMs: Date.now() });
    // Under the stale window: still refreshing.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBeGreaterThan(setsBeforeDeath);
    expect(clears).toHaveLength(0);

    // Past the 15s stale window with no new report: clear once.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(clears).toHaveLength(1);
    const setsAtClear = sets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBe(setsAtClear);
    expect(clears).toHaveLength(1);
  });

  it('old runner: with no turn ever reported, the heartbeat file still gates the refresh', async () => {
    const { sets, clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    // Never call noteTurnState. Past grace, a fresh heartbeat keeps typing on.
    for (let elapsed = 0; elapsed < 20_000; elapsed += 4_000) {
      touchHeartbeat(AG, SESS);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    const setsWhileFresh = sets.length;
    expect(setsWhileFresh).toBeGreaterThan(1);
    expect(clears).toHaveLength(0);

    // Heartbeat goes stale (no more touches): the refresh ends.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(clears).toHaveLength(1);
    const setsAtEnd = sets.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sets.length).toBe(setsAtEnd);
  });

  it('stopTypingRefresh clears the indicator once', async () => {
    const { clears } = captureSetAndClear();
    startTypingRefresh(SESS, AG, 'slack', 'C1', 'T1', 'slack-inst');
    await vi.advanceTimersByTimeAsync(0);

    stopTypingRefresh(SESS);
    expect(clears).toHaveLength(1);
    // A second stop finds no refresher — no double clear.
    stopTypingRefresh(SESS);
    expect(clears).toHaveLength(1);
  });

  it('noteTurnState with no active refresher creates none', async () => {
    const { sets } = captureSetAndClear();
    noteTurnState('sess-never', { turn: 'working', updatedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(sets).toHaveLength(0);
  });
});
