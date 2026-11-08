import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    MATTERMOST_BASE_URL: 'https://mm.example.test',
    MATTERMOST_BOT_TOKEN: 'abcdefghijklmnopqrstuvwxyz',
  })),
}));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('./chat-sdk-bridge.js', () => ({ createChatSdkBridge: vi.fn(() => ({})) }));

import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { renderPostable } from './mattermost-adapter/format.js';
import { registerChannelAdapter } from './channel-registry.js';
import './mattermost.js';

/** Mattermost counts runes; JS `length` counts UTF-16 units, so it is never smaller. */
const runes = (text: string) => [...text].length;

describe('mattermost channel factory', () => {
  beforeEach(() => vi.mocked(createChatSdkBridge).mockClear());

  it('tells the bridge to split replies longer than a Mattermost post', async () => {
    const registration = vi.mocked(registerChannelAdapter).mock.calls[0]?.[1];
    expect(registration).toBeDefined();
    await registration!.factory();

    const config = vi.mocked(createChatSdkBridge).mock.calls[0]?.[0];
    expect(config?.maxTextLength).toBe(16_383);
  });

  it('keeps every rendered chunk within 16383 runes', async () => {
    const { splitForLimit: realSplit } =
      await vi.importActual<typeof import('./chat-sdk-bridge.js')>('./chat-sdk-bridge.js');
    const registration = vi.mocked(registerChannelAdapter).mock.calls[0]![1];
    await registration.factory();
    const config = vi.mocked(createChatSdkBridge).mock.calls[0]![0];
    // Emoji placeholders grow when rendered; astral emoji are 2 UTF-16 units each.
    const reply = `${'word {{emoji:check}} '.repeat(1_200)}\n\n${'😀 '.repeat(6_000)}`;
    const transform = config.transformOutboundText ?? ((text: string) => text);
    const chunks = realSplit(transform(reply), config.maxTextLength!);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(runes(renderPostable({ markdown: chunk }).message)).toBeLessThanOrEqual(16_383);
  });
});
