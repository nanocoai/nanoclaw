import { createTelegramAdapter } from '@chat-adapter/telegram';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPollDeadline, withPollDeadline } from './telegram-poll-deadline.js';

describe('getUpdates deadline', () => {
  // Resolves only when its signal aborts, like a request on a black-holed socket.
  const hanging = vi.fn(
    (_method: string, _payload?: unknown, request?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        request?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  );

  it('turns a hung long poll into a retryable error', async () => {
    vi.useFakeTimers();
    try {
      const pending = withPollDeadline(hanging)('getUpdates', { timeout: 30 });
      const assertion = expect(pending).rejects.toThrow(/no response in 60s/);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      await expect(pending).rejects.not.toHaveProperty('name', 'AbortError');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still stops cleanly when the adapter aborts polling', async () => {
    const outer = new AbortController();
    const pending = withPollDeadline(hanging)('getUpdates', { timeout: 30 }, { signal: outer.signal });
    outer.abort();
    await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  });

  it('leaves other methods alone', async () => {
    const original = vi.fn(async () => 'ok');
    const request = { signal: new AbortController().signal };
    await expect(withPollDeadline(original)('sendMessage', { text: 'x' }, request)).resolves.toBe('ok');
    expect(original).toHaveBeenCalledWith('sendMessage', { text: 'x' }, request);
  });
});

describe('installPollDeadline', () => {
  it('wraps the adapter instance it is given', () => {
    const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = (adapter as any).telegramFetch;
    expect(installPollDeadline(adapter)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((adapter as any).telegramFetch).not.toBe(before);
  });

  it('leaves an adapter without telegramFetch alone', () => {
    expect(installPollDeadline({})).toBe(false);
  });
});

describe('the adapter poll loop', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Drives the adapter's own pollingLoop: the first getUpdates hangs like a
  // black-holed socket, later ones return empty after the 30 s poll. Returns how many
  // getUpdates requests the loop made within the given time.
  async function pollsWithin(ms: number, deadline: boolean): Promise<number> {
    vi.useFakeTimers();
    let polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
        const method = url.slice(url.lastIndexOf('/') + 1);
        if (method === 'getMe') return Response.json({ ok: true, result: { id: 1, username: 'test_bot' } });
        if (method !== 'getUpdates') return Response.json({ ok: true, result: true });
        const hung = ++polls === 1;
        return new Promise((resolve, reject) => {
          // A healthy long poll returns empty after 30 s; the first one never does.
          const timer = hung ? undefined : setTimeout(() => resolve(Response.json({ ok: true, result: [] })), 30_000);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }),
    );
    const adapter = createTelegramAdapter({ botToken: '1:test', mode: 'polling' });
    if (deadline) expect(installPollDeadline(adapter)).toBe(true);
    const store = new Map<string, unknown>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = adapter as any;
    a.chat = {
      getState: () => ({
        get: async (k: string) => store.get(k),
        set: async (k: string, v: unknown) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
      }),
    };
    await adapter.startPolling({ deleteWebhook: false, timeout: 30, retryDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(ms);
    const count = polls;
    a.pollingActive = false;
    a.pollingAbortController?.abort();
    await vi.advanceTimersByTimeAsync(1000);
    return count;
  }

  it('polls again after a hung getUpdates', async () => {
    expect(await pollsWithin(65_000, true)).toBeGreaterThan(1);
  });

  it('stays stuck without the deadline', async () => {
    expect(await pollsWithin(65_000, false)).toBe(1);
  });
});
