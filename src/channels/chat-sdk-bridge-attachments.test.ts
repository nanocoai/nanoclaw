/**
 * Attachment bytes through the real bridge path: fetchData may return
 * Buffer, ArrayBuffer (Telegram since 4.39) or Uint8Array; all must reach
 * the host as base64 of the same bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

describe('chat-sdk bridge attachment download', () => {
  it('base64-encodes Buffer, ArrayBuffer and Uint8Array fetchData results', async () => {
    let chat: ChatDriver | null = null;
    const adapter = {
      name: 'telegram',
      initialize: async (c: ChatDriver) => {
        chat = c;
      },
      channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
    } as unknown as Adapter;

    const received: InboundMessage[] = [];
    const hostConfig: ChannelSetup = {
      onInbound: (_platformId, _threadId, message) => {
        received.push(message);
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    };

    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await bridge.setup(hostConfig);

    const bytes = Buffer.from('telegram attachment');
    const arrayBuffer = new ArrayBuffer(bytes.length);
    new Uint8Array(arrayBuffer).set(bytes);
    const backing = new Uint8Array(bytes.length + 4);
    backing.set(bytes, 2);

    const fetchers: Array<() => Promise<unknown>> = [
      async () => Buffer.from(bytes),
      async () => arrayBuffer,
      async () => backing.subarray(2, 2 + bytes.length),
    ];
    const payload = {
      id: 'msg-att-1',
      text: 'see attached',
      author: { userId: 'U1', userName: 'human', fullName: 'A Human', isBot: false, isMe: false },
    };
    await chat!.processMessage(adapter, 'telegram:C1:T1', {
      ...payload,
      attachments: fetchers.map((fetchData, i) => ({ type: 'file', name: `f${i}`, fetchData })),
      isMention: false,
      metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
      raw: undefined,
      toJSON: () => ({ ...payload }),
    });

    expect(received).toHaveLength(1);
    const attachments = (received[0].content as { attachments: Array<{ data?: string }> }).attachments;
    expect(attachments.map((a) => a.data)).toEqual(Array(3).fill(bytes.toString('base64')));
  });
});
