/**
 * The Chat SDK reports a failed inbound message (a handler that throws, a
 * state write that fails) only through its logger. These tests drive the
 * REAL bridge and the SDK's own dispatch: a stub adapter captures the
 * ChatInstance at initialize and pushes a message with `chat.processMessage`,
 * as in chat-sdk-bridge-inbound-policy.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Message, type Adapter } from 'chat';

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
  vi.mocked(log.info).mockClear();
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
    chatSdkLogger().error('Action processing error', { actionId: 'ncq:q-old:private release plan', messageId: 'm1' });
    chatSdkLogger().error('Action processing error', { actionId: 'ncq:q-new', messageId: 'm2' });

    expect(log.error).toHaveBeenCalledWith('chat-sdk: Button callbackUrl POST failed', {
      callbackUrl: 'https://hooks.example.com/…',
      err,
    });
    expect(log.error).toHaveBeenCalledWith('chat-sdk: Slash command processing error', {
      command: '/deploy',
      text: '[8 chars]',
    });
    // Old question cards carry the chosen answer after the second colon.
    expect(log.error).toHaveBeenCalledWith('chat-sdk: Action processing error', {
      actionId: 'ncq:q-old:…',
      messageId: 'm1',
    });
    expect(log.error).toHaveBeenCalledWith('chat-sdk: Action processing error', {
      actionId: 'ncq:q-new',
      messageId: 'm2',
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

  it('cuts every message-text key to its length', () => {
    chatSdkLogger().warn('Checking message patterns', { messageText: 'secret plans', text: 'more plans' });

    expect(log.warn).toHaveBeenCalledWith('chat-sdk: Checking message patterns', {
      messageText: '[12 chars]',
      text: '[10 chars]',
    });
  });

  it('logs a URL it cannot parse as [url], never the raw string', () => {
    // Port out of range: looks like a URL, but URL.canParse rejects it.
    chatSdkLogger().error('Button callbackUrl POST failed', {
      callbackUrl: 'https://hooks.example.com:99999/cb?token=s3cret',
    });

    expect(log.error).toHaveBeenCalledWith('chat-sdk: Button callbackUrl POST failed', { callbackUrl: '[url]' });
  });
});

/** A message the SDK can queue: it stores and rebuilds a real Message. */
function queuedMessage(id: string, threadId: string, text: string): Message {
  return new Message({
    id,
    threadId,
    text,
    formatted: { type: 'root', children: [] },
    raw: {},
    author: { userId: 'U1', userName: 'human', fullName: 'A Human', isBot: false, isMe: false },
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z'), edited: false },
    attachments: [],
    isMention: false,
  });
}

/** The first inbound message holds the thread until released, so later ones queue behind it. */
function holdingHost() {
  const seen: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let started = () => {};
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  const host: ChannelSetup = {
    onInbound: async (_platformId, _threadId, message) => {
      seen.push(message.id);
      if (seen.length > 1) return;
      started();
      await held;
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  return { host, seen, firstStarted, release: () => release() };
}

function loggedText(): string {
  const calls = [log.debug, log.info, log.warn, log.error].flatMap((fn) => vi.mocked(fn).mock.calls);
  return JSON.stringify(calls);
}

describe('queue mode: a held message the SDK drops is logged at warn', () => {
  const tid = 'github:R1:T1';

  it('older held messages passed over for the newest', async () => {
    const { adapter, chat } = makeStubAdapter('github');
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, concurrency: 'queue' });
    const { host, seen, firstStarted, release } = holdingHost();
    await bridge.setup(host);

    const first = chat().processMessage(adapter, tid, queuedMessage('m1', tid, 'first secret'));
    await firstStarted;
    await chat().processMessage(adapter, tid, queuedMessage('m2', tid, 'second secret'));
    await chat().processMessage(adapter, tid, queuedMessage('m3', tid, 'third secret'));
    release();
    await first;

    expect(seen).toEqual(['m1', 'm3']);
    expect(log.warn).toHaveBeenCalledWith(
      'chat-sdk: message-dequeued',
      expect.objectContaining({ threadId: tid, messageId: 'm3', skippedCount: 1 }),
    );
    expect(loggedText()).not.toContain('secret');

    await bridge.teardown();
  });

  it('a held message that expires', async () => {
    const { adapter, chat } = makeStubAdapter('github');
    // The SDK holds a message for 90 s; its config object takes a shorter hold.
    const concurrency = { strategy: 'queue', queueEntryTtlMs: 0 } as never;
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, concurrency });
    const { host, seen, firstStarted, release } = holdingHost();
    await bridge.setup(host);

    const first = chat().processMessage(adapter, tid, queuedMessage('m1', tid, 'first secret'));
    await firstStarted;
    await chat().processMessage(adapter, tid, queuedMessage('m2', tid, 'second secret'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await first;

    expect(seen).toEqual(['m1']);
    expect(log.warn).toHaveBeenCalledWith(
      'chat-sdk: message-expired',
      expect.objectContaining({ threadId: tid, messageId: 'm2' }),
    );
    expect(loggedText()).not.toContain('secret');

    await bridge.teardown();
  });

  it('a drain that passes nothing over stays at debug', () => {
    chatSdkLogger().info('message-dequeued', { threadId: tid, messageId: 'm1', skippedCount: 0 });

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith('chat-sdk: message-dequeued', {
      threadId: tid,
      messageId: 'm1',
      skippedCount: 0,
    });
  });
});
