/**
 * Regression test for the Discord adapter's `maxTextLength` wiring.
 *
 * Discord hard-caps a message at 2000 chars; `@chat-adapter/discord` silently
 * truncates anything longer with an ellipsis. The Chat SDK bridge only engages
 * its `splitForLimit` chunker when the channel passes `maxTextLength`, so
 * discord.ts must hand that value into `createChatSdkBridge` — drop the line and
 * long replies regress to being truncated with no error.
 *
 * discord-registration.test.ts imports the real barrel to prove the channel
 * registers. This test instead needs to observe the *config* the factory builds,
 * so it stubs the factory's collaborators and captures the `createChatSdkBridge`
 * argument. The bridge/adapter are constructed only inside the factory (never at
 * import), so invoking it here is side-effect free.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChannelRegistration } from './adapter.js';
import type { ChatSdkBridgeConfig } from './chat-sdk-bridge.js';

const createDiscordAdapter = vi.fn(() => ({ name: 'discord-adapter' }));
const createChatSdkBridge = vi.fn((config: ChatSdkBridgeConfig) => ({ config }));
const registerChannelAdapter = vi.fn();
const readEnvFile = vi.fn(() => ({
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_PUBLIC_KEY: 'public-key',
  DISCORD_APPLICATION_ID: 'app-id',
}));

vi.mock('@chat-adapter/discord', () => ({ createDiscordAdapter }));
vi.mock('../env.js', () => ({ readEnvFile }));
vi.mock('./chat-sdk-bridge.js', () => ({ createChatSdkBridge }));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter }));

describe('discord adapter maxTextLength', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes maxTextLength: 2000 to createChatSdkBridge so long replies chunk instead of truncating', async () => {
    await import('./discord.js'); // self-registers the factory on import

    const registration = registerChannelAdapter.mock.calls.find(([name]) => name === 'discord')?.[1] as
      | ChannelRegistration
      | undefined;
    expect(registration?.factory).toBeTypeOf('function');

    registration!.factory();

    expect(createChatSdkBridge).toHaveBeenCalledWith(
      expect.objectContaining({ supportsThreads: true, maxTextLength: 2000 }),
    );
  });
});
