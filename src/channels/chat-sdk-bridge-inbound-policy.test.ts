/**
 * Tests for the bridge inbound-policy registration seam.
 *
 * `registerBridgeInboundPolicy(channelType, wrap)` lets an installed module
 * wrap the host's ChannelSetup for one channel type at bridge setup — the
 * single point every inbound dispatch path (onSubscribedMessage /
 * onNewMention / onDirectMessage / onNewMessage) reads back through — instead
 * of editing the bridge source. Bridges whose channel type has no registered
 * policy are unaffected.
 *
 * Inbound is driven through the REAL bridge path: a stub adapter captures the
 * ChatInstance during `chat.initialize()` and pushes duck-typed messages via
 * `chat.processMessage(...)`, so the Chat SDK's own dispatch (dedupe,
 * pattern routing) delivers them to the bridge's handlers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createChatSdkBridge, registerBridgeInboundPolicy } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

/** Minimal ChatInstance surface the test drives. */
interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

/**
 * Stub adapter that captures the ChatInstance at initialize so tests can
 * push messages through the SDK's real dispatch into the bridge handlers.
 */
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
      if (!captured) throw new Error('adapter not initialized — call bridge.setup() first');
      return captured;
    },
  };
}

let nextMessageId = 0;

/** Duck-typed Chat SDK message — the fields the SDK dispatch + bridge read. */
function makeMessage(text: string): Record<string, unknown> {
  const id = `msg-${++nextMessageId}`;
  const payload = {
    id,
    text,
    author: { userId: 'U123', userName: 'human', fullName: 'A Human', isBot: false, isMe: false },
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

interface InboundCall {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

function makeHostConfig(): { hostConfig: ChannelSetup; calls: InboundCall[] } {
  const calls: InboundCall[] = [];
  const hostConfig: ChannelSetup = {
    onInbound: (platformId, threadId, message) => {
      calls.push({ platformId, threadId, message });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  return { hostConfig, calls };
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

// One policy for the whole file (module-level registry, one per channelType):
// blocks messages containing BLOCK, tags everything else with the instance
// key it was wrapped for, and records each wrap application.
const wrapApplications: string[] = [];
registerBridgeInboundPolicy('slack', (setup, instanceKey) => {
  wrapApplications.push(instanceKey);
  return {
    ...setup,
    onInbound(platformId, threadId, message) {
      const content = message.content as Record<string, unknown>;
      if (typeof content.text === 'string' && content.text.includes('BLOCK')) {
        return; // policy drop — never reaches the host
      }
      content.policyTag = `wrapped:${instanceKey}`;
      return setup.onInbound(platformId, threadId, message);
    },
  };
});

describe('registerBridgeInboundPolicy', () => {
  it('wraps inbound through the real bridge path: pass-through is tagged, policy drop never reaches the host', async () => {
    const { adapter, chat } = makeStubAdapter('slack');
    const { hostConfig, calls } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    await chat().processMessage(adapter, 'slack:C1:T1', makeMessage('hello there'));
    await chat().processMessage(adapter, 'slack:C1:T2', makeMessage('please BLOCK me'));

    expect(calls).toHaveLength(1);
    expect(calls[0].platformId).toBe('slack:C1');
    expect(calls[0].threadId).toBe('slack:C1:T1');
    const content = calls[0].message.content as Record<string, unknown>;
    expect(content.text).toBe('hello there');
    expect(content.policyTag).toBe('wrapped:slack');

    await bridge.teardown();
  });

  it('leaves unregistered channel types untouched (no wrap, no tag, no drop)', async () => {
    const { adapter, chat } = makeStubAdapter('discord');
    const { hostConfig, calls } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    const applicationsBefore = wrapApplications.length;
    await bridge.setup(hostConfig);

    await chat().processMessage(adapter, 'discord:C1:T1', makeMessage('please BLOCK me'));

    expect(wrapApplications).toHaveLength(applicationsBefore);
    expect(calls).toHaveLength(1);
    const content = calls[0].message.content as Record<string, unknown>;
    expect(content.text).toBe('please BLOCK me');
    expect(content.policyTag).toBeUndefined();

    await bridge.teardown();
  });

  it('applies the wrap once per bridge instance, passing each instance key', async () => {
    const applicationsBefore = wrapApplications.length;

    const def = makeStubAdapter('slack');
    const defBridge = createChatSdkBridge({ adapter: def.adapter, supportsThreads: true });
    const defHost = makeHostConfig();
    await defBridge.setup(defHost.hostConfig);

    const named = makeStubAdapter('slack');
    const namedBridge = createChatSdkBridge({
      adapter: named.adapter,
      instance: 'slack-tester',
      supportsThreads: true,
    });
    const namedHost = makeHostConfig();
    await namedBridge.setup(namedHost.hostConfig);

    expect(wrapApplications.slice(applicationsBefore)).toEqual(['slack', 'slack-tester']);

    // Each instance's inbound is tagged with ITS OWN key — per-instance
    // closures, not one shared wrapped setup.
    await named.chat().processMessage(named.adapter, 'slack:C9:T9', makeMessage('to the named instance'));
    expect(namedHost.calls).toHaveLength(1);
    expect((namedHost.calls[0].message.content as Record<string, unknown>).policyTag).toBe('wrapped:slack-tester');
    expect(defHost.calls).toHaveLength(0);

    await defBridge.teardown();
    await namedBridge.teardown();
  });
});
