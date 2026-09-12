/**
 * The address hooks: a created sandbox is registered and a refused name is
 * an operator-visible error (at once, or late when the account is slow); a
 * service that does not answer is asked again every minute until it does,
 * for a release too; neither ever fails the verb.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./sandboxes.js', () => ({
  registerSandbox: vi.fn(),
  unregisterSandbox: vi.fn(),
}));

import { fireSandboxCreated, fireSandboxRemoved } from '../../../code-mode/hooks.js';
import { log } from '../../../log.js';
import { registerSandbox, unregisterSandbox } from './sandboxes.js';
import { getHostShutdownCallbacks } from '../../../host-lifecycle.js';
import { ADDRESS_RETRY_MS, setAddressRetryTimersForTesting, untilAnswered } from './index.js';

const group = { id: 'ag-1', name: 'api', folder: 'api' };

/** A fake clock for the retry loop: every sleep is recorded and released by hand. */
function clock() {
  const sleeps: { ms: number; release: () => void }[] = [];
  setAddressRetryTimersForTesting({
    sleep: (ms) => new Promise<void>((resolve) => sleeps.push({ ms, release: resolve })),
  });
  return { sleeps, tick: () => sleeps.shift()?.release() };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => setAddressRetryTimersForTesting(null));

describe('the created hook', () => {
  it('registers the sandbox name and stays quiet when the account accepts or cannot be asked', async () => {
    vi.mocked(registerSandbox).mockResolvedValueOnce({ done: true, address: '2001:db8::2' });
    await fireSandboxCreated(group);
    expect(registerSandbox).toHaveBeenCalledWith('api');
    vi.mocked(registerSandbox).mockResolvedValueOnce({ done: false, code: 'not_enabled' });
    await fireSandboxCreated(group);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('reports a refused name as an error, even when the answer comes late', async () => {
    for (const code of ['invalid_name', 'name_reserved', 'name_taken']) {
      vi.mocked(registerSandbox).mockResolvedValueOnce({ done: false, code });
      await fireSandboxCreated(group);
      expect(log.error).toHaveBeenLastCalledWith(
        expect.stringContaining('refused'),
        expect.objectContaining({ sandbox: 'api', code }),
      );
    }

    vi.useFakeTimers();
    let late!: (outcome: { done: boolean; code?: string }) => void;
    vi.mocked(registerSandbox).mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
    const fired = fireSandboxCreated(group);
    await vi.advanceTimersByTimeAsync(5_000);
    await fired; // the verb moved on without the answer
    vi.mocked(log.error).mockClear();
    late({ done: false, code: 'name_taken' });
    await vi.advanceTimersByTimeAsync(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('refused'),
      expect.objectContaining({ code: 'name_taken' }),
    );
    vi.useRealTimers();
  });
});

describe('the retry loop', () => {
  it('asks again every minute while the service does not answer, then stops at the first final outcome', async () => {
    const c = clock();
    const attempt = vi
      .fn<() => Promise<{ done: boolean; code?: string; retryable?: boolean }>>()
      .mockResolvedValueOnce({ done: false, code: 'ECONNREFUSED', retryable: true })
      .mockResolvedValueOnce({ done: false, code: 'unavailable', retryable: true })
      .mockResolvedValueOnce({ done: true, address: '2001:db8::2' } as never);
    const outcome = untilAnswered('registration', 'api', attempt);
    await vi.waitFor(() => expect(c.sleeps).toHaveLength(1));
    expect(c.sleeps[0].ms).toBe(ADDRESS_RETRY_MS);
    expect(log.warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('retrying every minute'), {
      sandbox: 'api',
    });
    c.tick();
    await vi.waitFor(() => expect(c.sleeps).toHaveLength(1)); // the second wait
    c.tick();
    expect(await outcome).toEqual({ done: true, address: '2001:db8::2' });
    expect(attempt).toHaveBeenCalledTimes(3);

    // A refusal is final: no retry.
    const refused = vi.fn(async () => ({ done: false, code: 'name_taken' }));
    expect(await untilAnswered('registration', 'api', refused)).toEqual({ done: false, code: 'name_taken' });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('ends with the host: shutdown aborts a pending retry instead of holding the process', async () => {
    setAddressRetryTimersForTesting({
      sleep: (_ms, signal) =>
        new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const attempt = vi.fn(async () => ({ done: false, code: 'unreachable', retryable: true }));
    const outcome = untilAnswered('registration', 'api', attempt);
    await vi.waitFor(() => expect(attempt).toHaveBeenCalledTimes(1));
    for (const cb of getHostShutdownCallbacks()) await cb();
    expect(await outcome).toEqual({ done: false, code: 'unreachable', retryable: true });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('is the created hook’s patience too, without holding the verb', async () => {
    const c = clock();
    vi.mocked(registerSandbox)
      .mockResolvedValueOnce({ done: false, code: 'unreachable', retryable: true })
      .mockResolvedValueOnce({ done: true });
    vi.useFakeTimers();
    const fired = fireSandboxCreated(group);
    await vi.advanceTimersByTimeAsync(5_000);
    await fired;
    vi.useRealTimers();
    expect(registerSandbox).toHaveBeenCalledTimes(1);
    c.tick();
    await vi.waitFor(() => expect(registerSandbox).toHaveBeenCalledTimes(2));
  });
});

describe('the removed hook', () => {
  it('frees the address without holding the verb, and keeps trying while the service does not answer', async () => {
    const c = clock();
    vi.mocked(unregisterSandbox)
      .mockResolvedValueOnce({ done: false, code: 'unreachable', retryable: true })
      .mockResolvedValueOnce({ done: true });
    await fireSandboxRemoved(group);
    expect(unregisterSandbox).toHaveBeenCalledWith('api');
    await vi.waitFor(() => expect(c.sleeps).toHaveLength(1));
    c.tick();
    await vi.waitFor(() => expect(unregisterSandbox).toHaveBeenCalledTimes(2));
  });
});
