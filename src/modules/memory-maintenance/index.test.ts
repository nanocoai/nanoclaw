/**
 * Driven through the real routeInbound path, so these go red if the module's
 * import is dropped from src/modules/index.ts.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-memory-module',
  GROUPS_DIR: '/tmp/nanoclaw-test-memory-module/groups',
  TIMEZONE: 'UTC',
}));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-memory-module';

import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { createSession, findTaskSessions } from '../../db/sessions.js';
import { routeInbound } from '../../router.js';
import { withMailboxSession } from '../../session-manager.js';
import { MEMORY_MAINTENANCE_TASKS } from './tasks.js';
import type { ChannelAdapter, ChannelDefaults } from '../../channels/adapter.js';

// What src/index.ts imports — deleting the module's line from it fails these.
import '../index.js';

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const now = (): string => new Date().toISOString();
let count = 0;

/** A wired agent group, ready to receive its first message. */
async function newAgent(): Promise<string> {
  const id = `ag-${++count}`;
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: `mg-${id}`,
    channel_type: 'testchat',
    platform_id: `testchat:${id}`,
    instance: 'testchat',
    name: id,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: `mga-${id}`,
    messaging_group_id: `mg-${id}`,
    agent_group_id: id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
  return id;
}

async function inbound(agentGroupId: string, threadId: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: `testchat:${agentGroupId}`,
    threadId,
    message: {
      id: `m-${agentGroupId}-${threadId}`,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'U1', text: 'hello' }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
  });
  // The hook is fire-and-forget — let it settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function series(agentGroupId: string): Promise<{ slug: string; status: string; recurrence: string | null }[]> {
  const out: { slug: string; status: string; recurrence: string | null }[] = [];
  for (const session of await findTaskSessions(agentGroupId)) {
    const rows = await withMailboxSession(agentGroupId, session.id, (m) => m.listLiveTasks());
    for (const row of rows) {
      out.push({
        slug: (row.seriesId ?? '').replace(/-[0-9a-f]{4}$/, ''),
        status: row.status,
        recurrence: row.recurrence,
      });
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  registerChannelAdapter('testchat', {
    factory: (): ChannelAdapter => ({
      name: 'testchat',
      channelType: 'testchat',
      supportsThreads: true,
      defaults,
      setup: async () => {},
      teardown: async () => {},
      isConnected: () => true,
      deliver: async () => undefined,
    }),
    defaults,
  });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('memory-maintenance module', () => {
  it("seeds a new agent's first conversation with the hygiene series, paused", async () => {
    const agent = await newAgent();

    await inbound(agent, 't-1');

    expect(await series(agent)).toEqual([{ slug: 'memory-hygiene', status: 'paused', recurrence: '0 8 * * 0' }]);
  });

  // One series only: two overlapping passes would rewrite one memory tree from
  // two containers with nothing serializing them.
  it('schedules exactly one weekly series and names the skill, with no destination', () => {
    expect(MEMORY_MAINTENANCE_TASKS).toHaveLength(1);
    const prompts = MEMORY_MAINTENANCE_TASKS.map((t) => t.prompt);
    expect(prompts.every((p) => p.includes('memory-hygiene skill') && !p.includes('<message'))).toBe(true);
  });

  // No backfill: an agent that was already talking never gets them.
  it('leaves an agent that already had a conversation alone', async () => {
    const agent = await newAgent();
    await createSession({
      id: `pre-${agent}`,
      agent_group_id: agent,
      messaging_group_id: `mg-${agent}`,
      thread_id: 'older',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });

    await inbound(agent, 't-new');

    expect(await series(agent)).toEqual([]);
  });

  it('never recreates a series the operator deleted', async () => {
    const agent = await newAgent();
    await inbound(agent, 't-1');
    for (const session of await findTaskSessions(agent)) {
      const rows = await withMailboxSession(agent, session.id, (m) => m.listLiveTasks());
      for (const row of rows) await withMailboxSession(agent, session.id, (m) => m.deleteTask(row.seriesId ?? row.id));
    }

    await inbound(agent, 't-2');

    expect(await series(agent)).toEqual([]);
  });
});
