/**
 * Typing-refresh behavior tests.
 *
 * Three tick sites can fire setTyping — the immediate tick on a new
 * refresher, the 4s interval tick, and the immediate re-trigger when
 * startTypingRefresh is called for an already-refreshing session. All three
 * must forward the adapter instance, or a named instance's typing indicator
 * fires through the wrong bot. The lifecycle case also verifies that a live
 * processing claim keeps refreshes alive through a silent provider wait.
 */
import fs from 'fs';

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing' };
});

import { initSessionFolder, openOutboundDbRw } from '../../session-manager.js';
import { setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

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

beforeEach(() => {
  fs.rmSync('/tmp/nanoclaw-test-typing', { recursive: true, force: true });
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  vi.useRealTimers();
  fs.rmSync('/tmp/nanoclaw-test-typing', { recursive: true, force: true });
});

describe('startTypingRefresh — instance forwarding', () => {
  it('immediate tick passes the instance to the adapter', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'slack', 'slack:C1', null, 'slack-tester');
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
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
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
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'slack', 'slack:C1', null, 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Second call for the same session: immediate tick with the new value.
    startTypingRefresh('sess-1', 'ag-1', 'message-2', 'slack', 'slack:C1', null, 'slack-worker');
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
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'slack', 'slack:C1', 'T1', 'slack-tester');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Same session re-triggered from a different platform and chat
    // (agent-shared sessions span messaging groups). The stored entry must
    // not tear: keeping the old address with the new instance would hand a
    // telegram platformId to the slack-tester adapter on the next tick.
    startTypingRefresh('sess-1', 'ag-1', 'message-2', 'telegram', 'tg:99', null, 'telegram');
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

describe('startTypingRefresh — turn lifecycle', () => {
  it('keeps refreshing through silent work and stops when the turn completes', async () => {
    initSessionFolder('ag-1', 'sess-1');
    const db = openOutboundDbRw('ag-1', 'sess-1');
    db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
      'message-1',
      'processing',
      new Date().toISOString(),
    );
    db.close();

    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'telegram', 'tg:99', null, 'telegram');

    // Cross the 15s cold-start grace period without heartbeat updates.
    // The processing claim must keep the 4s refresh alive.
    await vi.advanceTimersByTimeAsync(20_500);
    expect(calls).toHaveLength(6);

    const completedDb = openOutboundDbRw('ag-1', 'sess-1');
    completedDb.prepare("UPDATE processing_ack SET status = 'completed' WHERE message_id = 'message-1'").run();
    completedDb.close();

    const callsAtCompletion = calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(callsAtCompletion);
  });

  it('does not refresh after a fast turn completes inside startup grace', async () => {
    initSessionFolder('ag-1', 'sess-1');
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'telegram', 'tg:99', null, 'telegram');
    await vi.advanceTimersByTimeAsync(0);

    const db = openOutboundDbRw('ag-1', 'sess-1');
    db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
      'message-1',
      'completed',
      new Date().toISOString(),
    );
    db.close();

    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls).toHaveLength(1);
  });

  it('ignores processing claims from a different message', async () => {
    initSessionFolder('ag-1', 'sess-1');
    const db = openOutboundDbRw('ag-1', 'sess-1');
    const insert = db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)');
    insert.run('message-1', 'completed', new Date().toISOString());
    insert.run('message-2', 'processing', new Date().toISOString());
    db.close();

    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'telegram', 'tg:99', null, 'telegram');

    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls).toHaveLength(1);
  });

  it('retries after processing state cannot be read', async () => {
    initSessionFolder('ag-1', 'sess-1');
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'message-1', 'telegram', 'tg:99', null, 'telegram');
    fs.rmSync('/tmp/nanoclaw-test-typing', { recursive: true, force: true });

    await vi.advanceTimersByTimeAsync(20_500);
    expect(calls).toHaveLength(6);

    initSessionFolder('ag-1', 'sess-1');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(6);
  });
});
