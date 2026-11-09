import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PingOutcome } from './agent-ping.js';
import { EXTRA_WAIT_MS, FIRST_WAIT_MS, waitForFirstReply, type WaitChoice } from './first-chat-wait.js';

function fakePing() {
  let resolve!: (outcome: PingOutcome) => void;
  const outcome = new Promise<PingOutcome>((r) => (resolve = r));
  const stop = vi.fn(() => resolve({ result: 'no_reply' }));
  return { ping: { outcome, stop }, reply: (o: PingOutcome = { result: 'ok' }) => resolve(o) };
}

/** Answers each question in turn; `undefined` leaves it open until the signal aborts it. */
function answers(...choices: Array<WaitChoice | undefined>) {
  const asked: number[] = [];
  const signals: AbortSignal[] = [];
  const ask = vi.fn((waitedMs: number, signal: AbortSignal) => {
    asked.push(waitedMs);
    signals.push(signal);
    const choice = choices.shift();
    if (choice) return Promise.resolve(choice);
    return new Promise<WaitChoice | undefined>((resolve) => signal.addEventListener('abort', () => resolve(undefined)));
  });
  return { ask, asked, signals };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('waitForFirstReply', () => {
  it('returns a reply inside the first window without asking', async () => {
    const { ping, reply } = fakePing();
    const { ask } = answers();
    const done = waitForFirstReply({ ping, interactive: true, ask });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS - 1000);
    reply();
    await expect(done).resolves.toEqual({ outcome: { result: 'ok' }, keptWaiting: 0, skipped: false });
    expect(ask).not.toHaveBeenCalled();
    expect(ping.stop).not.toHaveBeenCalled();
  });

  it('gives up after the first window without asking when nobody can answer', async () => {
    const { ping } = fakePing();
    const { ask } = answers();
    const done = waitForFirstReply({ ping, interactive: false, ask });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS - 1);
    expect(ping.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toEqual({ outcome: { result: 'no_reply' }, keptWaiting: 0, skipped: false });
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeps waiting for another window when asked to', async () => {
    const { ping, reply } = fakePing();
    const { ask, asked } = answers('wait');
    const done = waitForFirstReply({ ping, interactive: true, ask });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS);
    expect(asked).toEqual([FIRST_WAIT_MS]);
    await vi.advanceTimersByTimeAsync(EXTRA_WAIT_MS - 1000);
    expect(ask).toHaveBeenCalledTimes(1);
    reply();
    await expect(done).resolves.toEqual({ outcome: { result: 'ok' }, keptWaiting: 1, skipped: false });
    expect(ping.stop).not.toHaveBeenCalled();
  });

  it('asks again after every extra window and stops the ping on skip', async () => {
    const { ping } = fakePing();
    const { ask, asked } = answers('wait', 'wait', 'skip');
    const done = waitForFirstReply({ ping, interactive: true, ask });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS + 2 * EXTRA_WAIT_MS);
    await expect(done).resolves.toEqual({ outcome: { result: 'no_reply' }, keptWaiting: 2, skipped: true });
    expect(asked).toEqual([FIRST_WAIT_MS, FIRST_WAIT_MS + EXTRA_WAIT_MS, FIRST_WAIT_MS + 2 * EXTRA_WAIT_MS]);
    expect(ping.stop).toHaveBeenCalledTimes(1);
  });

  it('closes the open question when the reply lands first', async () => {
    const { ping, reply } = fakePing();
    const { ask, signals } = answers(undefined);
    const done = waitForFirstReply({ ping, interactive: true, ask });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS + 5000);
    reply();
    await expect(done).resolves.toEqual({ outcome: { result: 'ok' }, keptWaiting: 0, skipped: false });
    expect(signals[0].aborted).toBe(true);
    expect(signals[0].reason).toEqual({ result: 'ok' });
    expect(ping.stop).not.toHaveBeenCalled();
  });

  it('keeps a reply that arrives as the user picks skip', async () => {
    const { ping, reply } = fakePing();
    const ask = vi.fn(async () => {
      reply();
      return 'skip' as const;
    });
    const done = waitForFirstReply({ ping, interactive: true, ask });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS);
    await expect(done).resolves.toEqual({ outcome: { result: 'ok' }, keptWaiting: 0, skipped: false });
    expect(ping.stop).not.toHaveBeenCalled();
  });

  it('does not count a skip as skipped when stopping finds a reply', async () => {
    let resolve!: (outcome: PingOutcome) => void;
    const outcome = new Promise<PingOutcome>((r) => (resolve = r));
    const ping = { outcome, stop: vi.fn(() => resolve({ result: 'ok' })) };
    const done = waitForFirstReply({ ping, interactive: true, ask: async () => 'skip' as const });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS);
    await expect(done).resolves.toEqual({ outcome: { result: 'ok' }, keptWaiting: 0, skipped: false });
  });

  it('does not count a skip as skipped when stopping finds a failure', async () => {
    let resolve!: (outcome: PingOutcome) => void;
    const outcome = new Promise<PingOutcome>((r) => (resolve = r));
    const ping = { outcome, stop: vi.fn(() => resolve({ result: 'auth_error' })) };
    const done = waitForFirstReply({ ping, interactive: true, ask: async () => 'skip' as const });
    await vi.advanceTimersByTimeAsync(FIRST_WAIT_MS);
    await expect(done).resolves.toEqual({ outcome: { result: 'auth_error' }, keptWaiting: 0, skipped: false });
  });

  it('returns at once when the chat client ends early', async () => {
    const { ping, reply } = fakePing();
    const { ask } = answers();
    const done = waitForFirstReply({ ping, interactive: true, ask });
    reply({ result: 'socket_error' });
    await expect(done).resolves.toEqual({ outcome: { result: 'socket_error' }, keptWaiting: 0, skipped: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
