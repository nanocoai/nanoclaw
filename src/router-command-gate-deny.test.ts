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
  getDb,
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

// Lets a test hold the command gate (e.g. a slow admin lookup) and pick its answer.
const gateHold = vi.hoisted(() => ({
  until: null as Promise<void> | null,
  pass: false,
  reached: vi.fn(),
}));
vi.mock('./command-gate.js', async () => {
  const actual = await vi.importActual<typeof import('./command-gate.js')>('./command-gate.js');
  return {
    ...actual,
    gateCommand: async (...args: Parameters<typeof actual.gateCommand>) => {
      if (gateHold.until) {
        gateHold.reached();
        await gateHold.until;
      }
      return gateHold.pass ? { action: 'pass' as const } : actual.gateCommand(...args);
    },
  };
});

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

function sendClear(isGroup = false): Promise<void> {
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
      isGroup,
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
    // A denied command creates no session, so no outbound.db exists at all.
    expect(outboundRowCounts()).toEqual([]);
    const { wakeContainer } = await import('./container-runner.js');
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });

  it('a mentioned denied command does not make a mention-sticky thread active', async () => {
    await seed();
    await getDb().run("UPDATE messaging_groups SET is_group = 1 WHERE id = 'mg-1'");
    await getDb().run("UPDATE messaging_group_agents SET engage_mode = 'mention-sticky' WHERE id = 'mga-1'");
    let release: () => void = () => {};
    const replyHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = recordingAdapter(async () => {
      await replyHeld;
      return 'platform-msg-1';
    });

    const clear = sendClear(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // An unmentioned follow-up while the denial reply is still being sent.
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:C1',
      threadId: null,
      message: {
        id: 'm2',
        kind: 'chat-sdk',
        content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text: 'so what now' }),
        timestamp: new Date().toISOString(),
        isGroup: true,
      },
    });
    release();
    await clear;

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

  it('a follow-up routed while a first mentioned command is gated still engages', async () => {
    await seed();
    recordingAdapter(async () => 'platform-msg-1');
    await getDb().run("UPDATE messaging_groups SET is_group = 1 WHERE id = 'mg-1'");
    await getDb().run(
      "UPDATE messaging_group_agents SET engage_mode = 'mention-sticky', ignored_message_policy = 'drop' WHERE id = 'mga-1'",
    );
    const { wakeContainer } = await import('./container-runner.js');
    vi.mocked(wakeContainer).mockClear();
    let release: () => void = () => {};
    gateHold.reached.mockClear();
    gateHold.pass = true;
    gateHold.until = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const clear = sendClear(true);
      await vi.waitFor(() => expect(gateHold.reached).toHaveBeenCalledTimes(1));
      gateHold.until = null;

      await routeInbound({
        channelType: 'testchat',
        platformId: 'testchat:C1',
        threadId: null,
        message: {
          id: 'm2',
          kind: 'chat-sdk',
          content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text: 'and keep the notes' }),
          timestamp: new Date().toISOString(),
          isGroup: true,
        },
      });
      expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
      release();
      await clear;
      expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(2);
    } finally {
      gateHold.until = null;
      gateHold.pass = false;
      release();
    }
  });
});
