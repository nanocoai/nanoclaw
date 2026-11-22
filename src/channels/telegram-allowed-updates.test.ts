/**
 * Guards against the regression in issue #2989: Telegram persists
 * `allowed_updates` server-side per bot token — "if not specified, the
 * previous setting will be used" (Bot API docs). A token that ever polled
 * with a narrower list (e.g. a v1 install) would silently blackhole update
 * types the adapter never asks for again, most visibly `channel_post`
 * (broadcast channels going completely dead with no error, no log line).
 *
 * This asserts telegram.ts's factory always passes an explicit
 * `longPolling.allowedUpdates` that includes the full set of update types
 * we route on, so the server-side filter can never leak in unnoticed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createTelegramAdapterMock = vi.fn((_config: { longPolling?: { allowedUpdates?: string[] } }) => ({
  name: 'telegram',
}));

vi.mock('@chat-adapter/telegram', () => ({
  createTelegramAdapter: createTelegramAdapterMock,
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'test-token' }),
}));

vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: vi.fn(() => ({ setup: vi.fn() })),
}));

vi.mock('./telegram-pairing.js', () => ({
  tryConsume: vi.fn(),
}));

let registeredFactory: (() => unknown) | undefined;

vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: vi.fn((_name: string, registration: { factory: () => unknown }) => {
    registeredFactory = registration.factory;
  }),
}));

describe('telegram allowedUpdates', () => {
  beforeEach(() => {
    vi.resetModules();
    createTelegramAdapterMock.mockClear();
    registeredFactory = undefined;
  });

  it('always passes an explicit allowedUpdates list that includes channel_post', async () => {
    await import('./telegram.js');
    expect(registeredFactory).toBeTypeOf('function');

    registeredFactory!();

    expect(createTelegramAdapterMock).toHaveBeenCalledTimes(1);
    const config = createTelegramAdapterMock.mock.calls[0][0];
    expect(config.longPolling?.allowedUpdates).toBeDefined();
    expect(config.longPolling!.allowedUpdates).toEqual(
      expect.arrayContaining(['message', 'edited_message', 'channel_post', 'edited_channel_post', 'callback_query']),
    );
  });
});
