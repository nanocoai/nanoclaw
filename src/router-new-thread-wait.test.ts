/**
 * A new thread's first message does not wait for the cross-session backfill
 * to show the person that the agent is on it, and it is recorded as the new
 * session's root in the conversation timeline, which later threads' backfills
 * read instead of opening this session's mailbox.
 *
 * Live (customer Host, remote mailbox, just restarted): a new Slack DM thread
 * showed nothing for 12 to 23 s while the backfill read its siblings.
 * Exercised through the REAL routeInbound path.
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

const backfill = vi.hoisted(() => ({ release: () => {}, started: 0 }));
vi.mock('./modules/cross-session-context/index.js', async () => {
  const actual = await vi.importActual<typeof import('./modules/cross-session-context/index.js')>(
    './modules/cross-session-context/index.js',
  );
  return {
    ...actual,
    // A backfill that is still reading when the typing indicator should show.
    backfillSession: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          backfill.started += 1;
          backfill.release = resolve;
        }),
    ),
  };
});
const typing = vi.hoisted(() => ({ starts: [] as string[] }));
vi.mock('./modules/typing/index.js', async () => {
  const actual = await vi.importActual<typeof import('./modules/typing/index.js')>('./modules/typing/index.js');
  return {
    ...actual,
    startTypingRefresh: vi.fn((sessionId: string) => {
      typing.starts.push(sessionId);
    }),
    stopTypingRefresh: vi.fn(),
  };
});

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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-new-thread-wait' };
});

const TEST_DIR = '/tmp/nanoclaw-test-new-thread-wait';

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
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text }),
      timestamp: now(),
      isMention,
      isGroup: false,
    },
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  typing.starts.length = 0;
  backfill.started = 0;
});

afterEach(async () => {
  backfill.release();
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('a new thread and the backfill', () => {
  it('starts the typing indicator while the backfill is still reading', async () => {
    await activate();
    await seedWiring({ sessionMode: 'per-thread' });

    const routed = inbound('m1', 'testchat:C1:171', 'hello there');
    await until(() => backfill.started > 0);
    expect(backfill.started).toBe(1);
    expect(typing.starts).toHaveLength(1);

    backfill.release();
    await routed;
  });

  it("records the new session's first message as its root in the conversation timeline", async () => {
    await activate();
    await seedWiring({ sessionMode: 'per-thread' });

    const routed = inbound('m1', 'testchat:C1:171', 'hello there');
    await until(() => backfill.started > 0);
    backfill.release();
    await routed;

    const { getDb } = await import('./db/connection.js');
    const rows = await getDb().all<{ session_id: string; text: string; sender: string; self: number }>(
      'SELECT session_id, text, sender, self FROM conversation_timeline',
    );
    const sessions = await getDb().all<{ id: string }>("SELECT id FROM sessions WHERE thread_id = 'testchat:C1:171'");
    expect(rows).toEqual([{ session_id: sessions[0]!.id, text: 'hello there', sender: 'Alex', self: 0 }]);
  });
});
