/**
 * readHistory through the real bridge and chat library: it reads a thread's
 * lines via the library's history API and refuses a thread of another chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

const hostConfig: ChannelSetup = {
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};

function message(
  id: string,
  text: string,
  author: { userId: string; fullName: string; isBot: boolean; isMe: boolean },
) {
  return {
    id,
    text,
    author: { userName: author.fullName.toLowerCase(), ...author },
    metadata: { dateSent: new Date(`2026-11-01T10:0${id.slice(-1)}:00.000Z`), edited: false },
  };
}

async function bridgeOver(fetchMessages: (threadId: string, options: unknown) => Promise<unknown>) {
  const adapter = {
    name: 'testchat',
    initialize: async () => {},
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
    fetchMessages,
  } as unknown as Adapter;
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
  await bridge.setup(hostConfig);
  return bridge;
}

describe('chat-sdk bridge readHistory', () => {
  it("returns the thread's lines, oldest first, with who wrote each", async () => {
    const fetchMessages = vi.fn(async () => ({
      messages: [
        message('m1', 'is the build green?', { userId: 'U2', fullName: 'Dana', isBot: false, isMe: false }),
        message('m2', 'not yet', { userId: 'B1', fullName: 'Pip', isBot: true, isMe: true }),
      ],
    }));
    const bridge = await bridgeOver(fetchMessages);

    const lines = await bridge.readHistory!('testchat:C1', 'testchat:C1:100', { limit: 101 });

    expect(fetchMessages).toHaveBeenCalledWith('testchat:C1:100', { limit: 101 });
    expect(lines).toEqual([
      {
        id: 'm1',
        timestamp: '2026-11-01T10:01:00.000Z',
        senderId: 'U2',
        senderName: 'Dana',
        text: 'is the build green?',
        isBot: false,
        isSelf: false,
      },
      {
        id: 'm2',
        timestamp: '2026-11-01T10:02:00.000Z',
        senderId: 'B1',
        senderName: 'Pip',
        text: 'not yet',
        isBot: true,
        isSelf: true,
      },
    ]);
  });

  it('refuses a thread that belongs to another chat, without reading it', async () => {
    const fetchMessages = vi.fn(async () => ({ messages: [] }));
    const bridge = await bridgeOver(fetchMessages);

    await expect(bridge.readHistory!('testchat:C1', 'testchat:C2:100', { limit: 101 })).rejects.toThrow(
      'not in this chat',
    );
    expect(fetchMessages).not.toHaveBeenCalled();
  });
});
