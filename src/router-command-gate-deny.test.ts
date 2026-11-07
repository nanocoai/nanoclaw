/**
 * Command-gate denial: a non-admin's admin command gets its "Permission
 * denied" reply straight through the delivery adapter, and the session's
 * outbound.db is left untouched — that file belongs to the container, and a
 * host write there can collide with its writes across a VM file share.
 *
 * Exercised through the REAL routeInbound path (adapter registry + seeded
 * wiring).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
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
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from './delivery.js';
import { routeInbound } from './router.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-command-gate-deny' };
});

const TEST_DIR = '/tmp/nanoclaw-test-command-gate-deny';

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

type DeliverCall = Parameters<ChannelDeliveryAdapter['deliver']>;

function recordingAdapter(deliver: (...args: DeliverCall) => Promise<string | undefined>): DeliverCall[] {
  const calls: DeliverCall[] = [];
  setDeliveryAdapter({
    deliver: async (...args) => {
      calls.push(args);
      return deliver(...args);
    },
  });
  return calls;
}

async function seed(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  const created_at = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at,
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    threads: 1,
    created_at,
  });
}

function sendClear(): Promise<void> {
  return routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: null,
    message: {
      id: 'm1',
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text: '/clear' }),
      timestamp: new Date().toISOString(),
      isMention: true,
      isGroup: false,
    },
  });
}

function outboundRowCounts(): number[] {
  const counts: number[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'outbound.db') {
        const db = new Database(full, { readonly: true });
        counts.push((db.prepare('SELECT count(*) AS c FROM messages_out').get() as { c: number }).c);
        db.close();
      }
    }
  };
  walk(TEST_DIR);
  return counts;
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

describe('command-gate denial', () => {
  it('replies through the delivery adapter and never writes outbound.db', async () => {
    await seed();
    const calls = recordingAdapter(async () => 'platform-msg-1');

    await sendClear();

    expect(calls).toEqual([
      [
        'testchat',
        'testchat:C1',
        null,
        'chat',
        JSON.stringify({ text: 'Permission denied: /clear requires admin access.' }),
        undefined,
        'testchat',
      ],
    ]);
    const counts = outboundRowCounts();
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((count) => count === 0)).toBe(true);
    const { wakeContainer } = await import('./container-runner.js');
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('a failed reply is logged, not thrown into inbound routing', async () => {
    await seed();
    const calls = recordingAdapter(async () => {
      throw new Error('platform down');
    });

    await expect(sendClear()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
