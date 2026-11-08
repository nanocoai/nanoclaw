/**
 * The Chat SDK reports a failed inbound message (a handler that throws, a
 * state write that fails) only through its logger. These tests drive the
 * REAL bridge and the SDK's own dispatch: a stub adapter captures the
 * ChatInstance at initialize and pushes a message with `chat.processMessage`,
 * as in chat-sdk-bridge-inbound-policy.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { log } from '../log.js';
import type { ChannelSetup } from './adapter.js';
import { chatSdkLogger, createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

function makeStubAdapter(name: string): { adapter: Adapter; chat: () => ChatDriver } {
  let captured: ChatDriver | null = null;
  const adapter = {
    name,
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

function makeMessage(id: string, text: string): Record<string, unknown> {
  const payload = {
    id,
    text,
    author: { userId: 'U1', userName: 'human', fullName: 'A Human', isBot: false, isMe: false },
  };
  return {
    ...payload,
    attachments: [],
    isMention: false,
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
    raw: undefined,
    toJSON: () => ({ ...payload }),
  };
}

function throwingHost(error: Error): ChannelSetup {
  return {
    onInbound: () => {
      throw error;
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
}

beforeEach(async () => {
  vi.mocked(log.error).mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.debug).mockClear();
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

describe('Chat SDK logs reach our log', () => {
  it('a failed inbound message is logged, with the real error', async () => {
    const { adapter, chat } = makeStubAdapter('slack');
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    const boom = new Error('route failed');
    await bridge.setup(throwingHost(boom));

    await expect(chat().processMessage(adapter, 'slack:C1:T1', makeMessage('m1', 'hello'))).rejects.toBe(boom);

    await vi.waitFor(() => expect(log.error).toHaveBeenCalled());
    const [message, data] = vi.mocked(log.error).mock.calls[0];
    expect(message).toBe('chat-sdk: Message processing error');
    expect(data).toEqual({ err: boom, threadId: 'slack:C1:T1' });

    await bridge.teardown();
  });

  it('maps levels: warn and error stay, info drops to our debug level, debug is dropped', () => {
    const logger = chatSdkLogger();
    logger.warn('Could not acquire lock on thread', { threadId: 't1' });
    logger.info('message-dropped', { threadId: 't1' });
    logger.debug('Pattern test', { text: 'secret plans' });

    expect(log.warn).toHaveBeenCalledWith('chat-sdk: Could not acquire lock on thread', { threadId: 't1' });
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith('chat-sdk: message-dropped', { threadId: 't1' });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keeps message text and URL secrets out of the log', () => {
    const err = new Error('Callback URL returned 503');
    chatSdkLogger().error('Button callbackUrl POST failed', {
      callbackUrl: 'https://hooks.example.com/cb/abc?token=s3cret',
      error: err,
    });
    chatSdkLogger().error('Slash command processing error', { command: '/deploy', text: 'prod now' });

    expect(log.error).toHaveBeenCalledWith('chat-sdk: Button callbackUrl POST failed', {
      callbackUrl: 'https://hooks.example.com/…',
      err,
    });
    expect(log.error).toHaveBeenCalledWith('chat-sdk: Slash command processing error', {
      command: '/deploy',
      text: '[8 chars]',
    });
  });

  it('child loggers keep the prefix chain; bare errors and extra args are kept', () => {
    const bare = new Error('bare');
    chatSdkLogger().child('slack').error('Adapter disconnect failed', bare, 'extra', 42);

    expect(log.error).toHaveBeenCalledWith('chat-sdk:slack: Adapter disconnect failed', {
      err: bare,
      args: ['extra', 42],
    });
  });
});
