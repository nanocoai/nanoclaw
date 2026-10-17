/**
 * The workspace hook: the bridge reads the sender's and the bot's workspace
 * off `message.raw` before dropping it, and carries them beside the content.
 *
 * Inbound is driven through the real bridge path, as in
 * chat-sdk-bridge-inbound-policy.test.ts: a stub adapter captures the
 * ChatInstance and pushes duck-typed messages through the SDK's dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge, type ChatSdkBridgeConfig } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

function makeStubAdapter(): { adapter: Adapter; chat: () => ChatDriver } {
  let captured: ChatDriver | null = null;
  const adapter = {
    name: 'slack',
    initialize: async (chat: ChatDriver) => {
      captured = chat;
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
  } as unknown as Adapter;
  return {
    adapter,
    chat: () => {
      if (!captured) throw new Error('adapter not initialized');
      return captured;
    },
  };
}

let nextId = 0;

function makeMessage(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const payload = {
    id: `msg-${++nextId}`,
    text: 'hello',
    author: { userId: 'U123', userName: 'human', fullName: 'A Human', isBot: false, isMe: false },
  };
  return {
    ...payload,
    attachments: [],
    isMention: false,
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
    raw,
    toJSON: () => ({ ...payload, raw }),
  };
}

async function inbound(
  extractWorkspace: ChatSdkBridgeConfig['extractWorkspace'],
  raw: Record<string, unknown> | undefined,
): Promise<InboundMessage> {
  const { adapter, chat } = makeStubAdapter();
  const calls: InboundMessage[] = [];
  const hostConfig: ChannelSetup = {
    onInbound: (_platformId, _threadId, message) => {
      calls.push(message);
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  const bridge = createChatSdkBridge({ adapter, supportsThreads: true, extractWorkspace });
  await bridge.setup(hostConfig);
  await chat().processMessage(adapter, 'slack:C1:T1', makeMessage(raw));
  await bridge.teardown();
  expect(calls).toHaveLength(1);
  return calls[0];
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

describe('extractWorkspace', () => {
  it('carries what the extractor reads off raw beside the content, never in it', async () => {
    const raw = { user: 'U123', team: 'T0SENDER' };
    const seen: unknown[] = [];
    const message = await inbound((r) => {
      seen.push(r);
      return { sender: r.team as string, bot: 'T0BOT' };
    }, raw);

    expect(seen).toEqual([raw]);
    expect(message.workspace).toEqual({ sender: 'T0SENDER', bot: 'T0BOT' });
    const content = message.content as Record<string, unknown>;
    expect(content.raw).toBeUndefined();
    expect(content).not.toHaveProperty('workspace');
  });

  it('leaves it unset with no extractor, an extractor that finds nothing, or no raw', async () => {
    expect((await inbound(undefined, { team: 'T0SENDER' })).workspace).toBeUndefined();
    expect((await inbound(() => null, { team: 'T0SENDER' })).workspace).toBeUndefined();

    const extractor = vi.fn(() => ({ sender: 'T0SENDER' }));
    expect((await inbound(extractor, undefined)).workspace).toBeUndefined();
    expect(extractor).not.toHaveBeenCalled();
  });
});
