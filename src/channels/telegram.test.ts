import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';

const bridgeSetup = vi.hoisted(() => vi.fn());

vi.mock('@chat-adapter/telegram', () => ({
  createTelegramAdapter: () => ({}),
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'test-token' }),
}));

vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: () => ({
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,
    setup: bridgeSetup,
    teardown: vi.fn(),
    isConnected: () => true,
    deliver: vi.fn(),
  }),
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupByPlatform: () => ({ id: 'mg-1' }),
  updateMessagingGroup: vi.fn(),
  createMessagingGroup: vi.fn(),
}));

vi.mock('../modules/permissions/db/user-roles.js', () => ({
  hasAnyOwner: () => true,
  grantRole: vi.fn(),
}));

vi.mock('../modules/permissions/db/users.js', () => ({
  upsertUser: vi.fn(),
}));

import { initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';
import { _resetForTest, _setStorePathForTest, createPairing, getStatus } from './telegram-pairing.js';
import './telegram.js';

const hostSetup: ChannelSetup = {
  onInbound: vi.fn(),
  onInboundEvent: vi.fn(),
  onMetadata: vi.fn(),
  onAction: vi.fn(),
};

let tmpDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-adapter-'));
  _setStorePathForTest(path.join(tmpDir, 'pairings.json'));
  bridgeSetup.mockClear();
  vi.mocked(hostSetup.onInbound).mockClear();
});

afterEach(async () => {
  await teardownChannelAdapters();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetForTest();
  _setStorePathForTest(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('telegram pairing identity lookup', () => {
  it('recovers from a transient getMe failure without weakening bot-name matching', async () => {
    let getMeCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/getMe')) {
        getMeCalls += 1;
        if (getMeCalls === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ ok: true, result: { username: 'realbot' } }));
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await initChannelAdapters(() => hostSetup);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getMeCalls).toBe(2);

    const intercepted = bridgeSetup.mock.calls[0]?.[0] as ChannelSetup;
    const accepted = await createPairing('main');
    await intercepted.onInbound('telegram:123', null, inbound(`@realbot ${accepted.code}`));
    expect(getStatus(accepted.code)).toBe('consumed');

    const rejected = await createPairing('main');
    await intercepted.onInbound('telegram:123', null, inbound(`@otherbot ${rejected.code}`));
    expect(getStatus(rejected.code)).toBe('pending');
    expect(getMeCalls).toBe(2);
  });
});

function inbound(text: string): InboundMessage {
  return {
    id: 'message-1',
    kind: 'chat-sdk',
    content: { text, author: { userId: 'user-1' } },
    timestamp: new Date().toISOString(),
  };
}
