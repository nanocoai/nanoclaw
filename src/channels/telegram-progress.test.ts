import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
const bridge = vi.hoisted(() => ({
  setTyping: vi.fn(async () => {}),
  deliver: vi.fn(async () => 'reply-1'),
  teardown: vi.fn(async () => {}),
}));

vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => k in env.values).map((k) => [k, env.values[k]])),
}));
vi.mock('@chat-adapter/telegram', () => ({ createTelegramAdapter: () => ({}) }));
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: () => ({ name: 'telegram', channelType: 'telegram', supportsThreads: false, ...bridge }),
}));

import {
  createTelegramBridge,
  createTelegramProgress,
  type TelegramProgress,
  type TelegramProgressApi,
} from './telegram.js';

const chat = 'telegram:42';

type Call = { op: 'send' | 'edit' | 'remove'; platformId: string; messageId?: number; text?: string };

function fakeApi(): { api: TelegramProgressApi; calls: Call[] } {
  const calls: Call[] = [];
  let nextId = 100;
  return {
    calls,
    api: {
      async send(platformId, text) {
        calls.push({ op: 'send', platformId, text });
        return nextId++;
      },
      async edit(platformId, messageId, text) {
        calls.push({ op: 'edit', platformId, messageId, text });
      },
      async remove(platformId, messageId) {
        calls.push({ op: 'remove', platformId, messageId });
      },
    },
  };
}

let progress: TelegramProgress;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  progress?.dispose();
  vi.useRealTimers();
});

/** Tick every 4s like the host typing refresh, for `ms` total. */
async function tickFor(ms: number, status?: string): Promise<void> {
  for (let t = 0; t < ms; t += 4_000) {
    await progress.tick(chat, status);
    await vi.advanceTimersByTimeAsync(4_000);
  }
}

describe('createTelegramProgress', () => {
  it('sends nothing for a turn that replies before showAfterMs', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api);
    await tickFor(8_000);
    await progress.finish(chat);
    expect(calls).toEqual([]);
  });

  it('sends one silent message once the turn outlasts showAfterMs', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api);
    await tickFor(16_000);
    expect(calls).toEqual([{ op: 'send', platformId: chat, text: 'Working on it… (12s)' }]);
  });

  it('edits the same message in place, no more often than editIntervalMs', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api);
    await tickFor(80_000);
    const sends = calls.filter((c) => c.op === 'send');
    const edits = calls.filter((c) => c.op === 'edit');
    expect(sends).toHaveLength(1);
    expect(edits.length).toBeGreaterThan(3);
    expect(edits.length).toBeLessThanOrEqual(7);
    expect(edits.every((e) => e.messageId === 100)).toBe(true);
    expect(edits[edits.length - 1].text).toMatch(/^Working on it… \(1m \d{2}s\)$/);
  });

  it('shows the status the host passes with the tick', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api);
    await tickFor(16_000, 'Running Bash');
    expect(calls[0].text).toBe('Working on it… (12s)\nRunning Bash');
  });

  it('deletes the message when the reply lands', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api);
    await tickFor(16_000);
    await progress.finish(chat);
    expect(calls[calls.length - 1]).toEqual({ op: 'remove', platformId: chat, messageId: 100 });
  });

  it('deletes the message once ticks stop without a reply', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api);
    await tickFor(16_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls[calls.length - 1]).toEqual({ op: 'remove', platformId: chat, messageId: 100 });
  });

  it('starts a fresh message for work that continues after a reply', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api);
    await tickFor(16_000);
    await progress.finish(chat);
    await tickFor(16_000);
    expect(calls.map((c) => c.op)).toEqual(['send', 'remove', 'send']);
    expect(calls[2].text).toBe('Working on it… (12s)');
  });

  it('deletes a message whose send is still in flight when the reply lands', async () => {
    const calls: Call[] = [];
    let resolveSend: (id: number) => void = () => {};
    const api: TelegramProgressApi = {
      send: (platformId, text) => {
        calls.push({ op: 'send', platformId, text });
        return new Promise((resolve) => (resolveSend = resolve));
      },
      edit: async () => {},
      remove: async (platformId, messageId) => {
        calls.push({ op: 'remove', platformId, messageId });
      },
    };
    progress = createTelegramProgress(api, { showAfterMs: 0 });
    void progress.tick(chat);
    const finished = progress.finish(chat);
    resolveSend(7);
    await finished;
    expect(calls).toEqual([
      { op: 'send', platformId: chat, text: 'Working on it… (0s)' },
      { op: 'remove', platformId: chat, messageId: 7 },
    ]);
  });

  it('keeps chats independent', async () => {
    const { api, calls } = fakeApi();
    progress = createTelegramProgress(api, { showAfterMs: 0 });
    await progress.tick(chat);
    await progress.tick('telegram:-99');
    await progress.finish(chat);
    expect(calls.map((c) => [c.op, c.platformId])).toEqual([
      ['send', chat],
      ['send', 'telegram:-99'],
      ['remove', chat],
    ]);
  });

  it('never throws when the Bot API fails', async () => {
    const api: TelegramProgressApi = {
      send: async () => {
        throw new Error('boom');
      },
      edit: async () => {
        throw new Error('boom');
      },
      remove: async () => {
        throw new Error('boom');
      },
    };
    progress = createTelegramProgress(api, { showAfterMs: 0 });
    await expect(progress.tick(chat)).resolves.toBeUndefined();
    await expect(progress.finish(chat)).resolves.toBeUndefined();
  });
});

describe('createTelegramBridge progress wiring', () => {
  const telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];

  beforeEach(() => {
    telegramCalls.length = 0;
    bridge.setTyping.mockClear();
    bridge.deliver.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = url.split('/').pop() ?? '';
        telegramCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves setTyping and deliver as the plain bridge when the flag is unset', async () => {
    env.values = { TELEGRAM_BOT_TOKEN: '1001:plain' };
    const adapter = createTelegramBridge()!;
    expect(adapter.setTyping).toBe(bridge.setTyping);
    expect(adapter.deliver).toBe(bridge.deliver);
  });

  it('drives the progress message from typing ticks and deletes it on reply', async () => {
    env.values = { TELEGRAM_BOT_TOKEN: '1002:progress', TELEGRAM_PROGRESS_MESSAGE: 'true' };
    const adapter = createTelegramBridge()!;
    for (let t = 0; t <= 12_000; t += 4_000) {
      await adapter.setTyping!(chat, null);
      await vi.advanceTimersByTimeAsync(4_000);
    }
    expect(bridge.setTyping).toHaveBeenCalledTimes(4);

    await adapter.deliver(chat, null, { kind: 'chat', content: { operation: 'reaction', messageId: 'm', emoji: 'x' } });
    const reply = await adapter.deliver(chat, null, { kind: 'chat', content: { text: 'done' } });
    expect(reply).toBe('reply-1');

    const progressCalls = telegramCalls.filter((c) => c.method !== 'getMe');
    expect(progressCalls).toEqual([
      {
        method: 'sendMessage',
        body: { chat_id: '42', text: 'Working on it… (12s)', disable_notification: true },
      },
      { method: 'deleteMessage', body: { chat_id: '42', message_id: 55 } },
    ]);
    await adapter.teardown();
  });
});
