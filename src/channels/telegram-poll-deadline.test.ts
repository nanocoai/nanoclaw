import { createTelegramAdapter } from '@chat-adapter/telegram';
import { describe, expect, it, vi } from 'vitest';

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
