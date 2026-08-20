/**
 * Router session-created hook: when an engaged (waking) message creates a
 * brand-new session, registered hooks are notified — after the triggering
 * message is written — with the resolved messaging group, thread id,
 * session mode, and triggering message. Fire-and-forget: a failing hook
 * never affects routing.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring), not by calling the dispatch directly.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { registerSessionCreatedHook, routeInbound, type SessionCreatedEvent } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';

// Mock container runner to prevent actual Docker spawning
vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-created' };
});

const TEST_DIR = '/tmp/nanoclaw-test-session-created';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedWiring(options: {
  isGroup?: 0 | 1;
  engageMode?: MessagingGroupAgent['engage_mode'];
  engagePattern?: string | null;
  sessionMode?: 'shared' | 'per-thread';
  ignoredMessagePolicy?: 'drop' | 'accumulate';
}): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: options.isGroup ?? 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: options.engageMode ?? 'pattern',
    engage_pattern: options.engagePattern === undefined ? '.' : options.engagePattern,
    sender_scope: 'all',
    ignored_message_policy: options.ignoredMessagePolicy ?? 'drop',
    session_mode: options.sessionMode ?? 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(id: string, threadId: string | null, text: string, isMention = true): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'U1', text }),
      timestamp: now(),
      isMention,
      isGroup: false,
    },
  });
  // Hooks are fire-and-forget — flush the microtask queue before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('registerSessionCreatedHook', () => {
  it('fires once per created session with the resolved wiring context, not again on reuse', async () => {
    await activate();
    await seedWiring({ sessionMode: 'per-thread' });

    const events: SessionCreatedEvent[] = [];
    registerSessionCreatedHook((event) => {
      events.push(event);
    });

    await inbound('m1', 'testchat:C1:171', 'hello there');
    expect(events).toHaveLength(1);
    expect(events[0].mg.id).toBe('mg-1');
    expect(events[0].platformId).toBe('testchat:C1');
    expect(events[0].threadId).toBe('testchat:C1:171');
    expect(events[0].sessionMode).toBe('per-thread');
    expect(events[0].session.agent_group_id).toBe('ag-1');
    expect(events[0].session.messaging_group_id).toBe('mg-1');
    expect(events[0].session.thread_id).toBe('testchat:C1:171');
    expect(events[0].message.id).toBe('m1');
    expect(events[0].message.kind).toBe('chat-sdk');
    expect(JSON.parse(events[0].message.content).text).toBe('hello there');

    // Same thread → session reuse → no second fire.
    await inbound('m2', 'testchat:C1:171', 'follow-up');
    expect(events).toHaveLength(1);

    // A different thread creates a NEW per-thread session → fires again.
    await inbound('m3', 'testchat:C1:942', 'new conversation');
    expect(events).toHaveLength(2);
    expect(events[1].threadId).toBe('testchat:C1:942');
  });

  it('does not fire for accumulate-only (non-engaged) messages even when they create the session', async () => {
    await activate();
    // A mention-mode wiring with accumulate policy: a non-mention message
    // takes the accumulate path (wake=false) and still creates the session.
    await seedWiring({ isGroup: 1, engageMode: 'mention', ignoredMessagePolicy: 'accumulate', sessionMode: 'shared' });

    const events: SessionCreatedEvent[] = [];
    registerSessionCreatedHook((event) => {
      events.push(event);
    });

    await inbound('m1', null, 'no mention here', false);
    expect(events).toHaveLength(0);

    // The engaged follow-up finds the session already created → still no fire.
    await inbound('m2', null, 'now with a mention', true);
    expect(events).toHaveLength(0);
  });

  it('receives the resolved session mode when the thread policy overrides the wiring', async () => {
    await activate();
    // Group chat + thread-enabled wiring: shared session_mode resolves to
    // per-thread at fanout — the hook must see the RESOLVED mode.
    await seedWiring({ isGroup: 1, engageMode: 'pattern', engagePattern: '.', sessionMode: 'shared' });

    const events: SessionCreatedEvent[] = [];
    registerSessionCreatedHook((event) => {
      events.push(event);
    });

    await inbound('m1', 'testchat:C1:333', 'kick off');
    expect(events).toHaveLength(1);
    expect(events[0].sessionMode).toBe('per-thread');
    expect(events[0].threadId).toBe('testchat:C1:333');
  });

  it('a throwing hook (sync or async) never breaks routing', async () => {
    await activate();
    await seedWiring({ sessionMode: 'per-thread' });

    registerSessionCreatedHook(() => {
      throw new Error('sync boom');
    });
    registerSessionCreatedHook(async () => {
      throw new Error('async boom');
    });
    const after: string[] = [];
    registerSessionCreatedHook((event) => {
      after.push(event.session.id);
    });

    const { wakeContainer } = await import('./container-runner.js');
    await expect(inbound('m1', 'testchat:C1:555', 'still routes')).resolves.toBeUndefined();

    // Hooks registered after the throwing ones still ran, and the message
    // still woke the container.
    expect(after).toHaveLength(1);
    expect(vi.mocked(wakeContainer)).toHaveBeenCalled();
  });
});
