/**
 * Mention-sticky engagement: a thread is sticky because we were mentioned in
 * it once, not because a session row happens to exist for it.
 *
 * The distinction is load-bearing when the wiring also accumulates ignored
 * messages: accumulation writes ambient chatter into a session (creating it
 * on first use) precisely so the context is there if the thread ever engages
 * us. That must not itself be the engagement.
 *
 * Exercised through the REAL routeInbound path, with `wakeContainer` standing
 * in for "the agent was asked to respond".
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
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-mention-sticky' };
});

const TEST_DIR = '/tmp/nanoclaw-test-mention-sticky';

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

async function seedWiring(
  options: {
    engageMode?: MessagingGroupAgent['engage_mode'];
    ignoredMessagePolicy?: 'drop' | 'accumulate';
  } = {},
): Promise<void> {
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
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: options.engageMode ?? 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: options.ignoredMessagePolicy ?? 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

const THREAD = 'testchat:C1:171';

async function inbound(id: string, text: string, isMention: boolean, threadId: string | null = THREAD): Promise<void> {
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
      isGroup: true,
    },
  });
}

async function wakes(): Promise<number> {
  const { wakeContainer } = await import('./container-runner.js');
  return vi.mocked(wakeContainer).mock.calls.length;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('mention-sticky engagement', () => {
  it('stays silent through ambient chatter it only accumulated', async () => {
    await activate();
    await seedWiring();

    // The first message creates the session as accumulated context...
    await inbound('m1', 'morning all', false);
    // ...and the second must not read that session into a subscription.
    await inbound('m2', 'anyone seen the deploy?', false);
    await inbound('m3', 'never mind, found it', false);

    expect(await wakes()).toBe(0);
  });

  it('sticks to the thread once it has been mentioned in it', async () => {
    await activate();
    await seedWiring();

    await inbound('m1', 'ambient', false);
    await inbound('m2', '@bot can you look at this', true);
    expect(await wakes()).toBe(1);

    // Follow-ups in the same thread need no second mention.
    await inbound('m3', 'and the one after it', false);
    expect(await wakes()).toBe(2);
  });

  it('is sticky per thread, not per chat', async () => {
    await activate();
    await seedWiring();

    await inbound('m1', '@bot over here', true, 'testchat:C1:171');
    expect(await wakes()).toBe(1);

    // A different thread in the same chat was never engaged.
    await inbound('m2', 'unrelated chatter', false, 'testchat:C1:942');
    expect(await wakes()).toBe(1);
  });
});
