import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatSdkBridgeConfig } from './chat-sdk-bridge.js';
import type { ChannelRegistration } from './adapter.js';

const mockDiscordAdapter = { name: 'discord-adapter' };
const createDiscordAdapter = vi.fn(() => mockDiscordAdapter);
const createChatSdkBridge = vi.fn((config: ChatSdkBridgeConfig) => ({
  name: 'discord',
  channelType: 'discord',
  supportsThreads: config.supportsThreads,
}));
const readEnvFile = vi.fn(() => ({
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_PUBLIC_KEY: 'public-key',
  DISCORD_APPLICATION_ID: 'app-id',
}));
const registerChannelAdapter = vi.fn();

vi.mock('@chat-adapter/discord', () => ({ createDiscordAdapter }));
vi.mock('../env.js', () => ({ readEnvFile }));
vi.mock('./chat-sdk-bridge.js', () => ({ createChatSdkBridge }));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter }));

describe('discord channel adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readEnvFile.mockReturnValue({
      DISCORD_BOT_TOKEN: 'bot-token',
      DISCORD_PUBLIC_KEY: 'public-key',
      DISCORD_APPLICATION_ID: 'app-id',
    });
  });

  it('sets Discord maxTextLength so long replies are chunked instead of truncated', async () => {
    await import('./discord.js');

    expect(registerChannelAdapter).toHaveBeenCalledWith(
      'discord',
      expect.objectContaining({ factory: expect.any(Function) }),
    );
    const registration = registerChannelAdapter.mock.calls[0][1] as ChannelRegistration;
    registration.factory();

    expect(createDiscordAdapter).toHaveBeenCalledWith({
      botToken: 'bot-token',
      publicKey: 'public-key',
      applicationId: 'app-id',
    });
    expect(createChatSdkBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: mockDiscordAdapter,
        botToken: 'bot-token',
        supportsThreads: true,
        maxTextLength: 2000,
      }),
    );
  });
});
