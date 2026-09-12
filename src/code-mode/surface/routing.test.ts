/**
 * The live seam end to end: a surface bound under the adapter's spelling
 * routes an inbound message — arriving exactly as the adapter stamps it —
 * into the sandbox's coding session (router session mode 'sandbox'), with
 * no second messaging group and no registration card; and a row the adapter
 * created before the bind is adopted and routes the same way.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
vi.mock('../../cli/resources/destinations.js', () => ({
  projectDestinationsToSessions: vi.fn(async () => {}),
}));
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-surface-routing/data' };
});

import type { ChannelAdapter, ChannelDefaults } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, getMessagingGroupsByChannel } from '../../db/messaging-groups.js';
import { findSandboxSessions, getSessionsByAgentGroup } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { routeInbound } from '../../router.js';
import { resolveSandboxSession } from '../../session-manager.js';
import { bindSessionSurface } from './binding.js';
import type { SurfaceHandle } from './types.js';
import '../index.js';

const TEST_ROOT = '/tmp/nanoclaw-test-session-surface-routing';
const GROUP = { id: 'ag-route-1', name: 'box', folder: 'box' };

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

/** A threaded chat adapter: ids spelled `chat:<conversation>[:<thread>]`. */
function chatAdapter(): ChannelAdapter {
  return {
    name: 'chat',
    channelType: 'chat',
    supportsThreads: true,
    defaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
    conversationPlatformId: (conversationId) => `chat:${conversationId}`,
  };
}

function provider() {
  let n = 0;
  return {
    spell: async (surfaceId: string) => ({ platformId: `chat:${surfaceId}`, instance: 'chat' }),
    open: async (sandbox: { id: string }): Promise<SurfaceHandle> => {
      n += 1;
      return { surfaceId: `C${n}`, sessionId: sandbox.id };
    },
  };
}

function inboundRows(sessionId: string): Array<{ id: string; platform_id: string | null; thread_id: string | null }> {
  const db = new Database(inboundDbPath(GROUP.id, sessionId), { readonly: true });
  try {
    return db.prepare('SELECT id, platform_id, thread_id FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      platform_id: string | null;
      thread_id: string | null;
    }>;
  } finally {
    db.close();
  }
}

/** A message as the adapter delivers it: platform id in its spelling, a thread id under the conversation. */
async function fromSurface(id: string, text: string, isMention = false): Promise<void> {
  await routeInbound({
    channelType: 'chat',
    platformId: 'chat:C1',
    threadId: 'chat:C1:1757600000.000100',
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text }),
      timestamp: new Date().toISOString(),
      isMention,
      isGroup: true,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ ...GROUP, agent_provider: null, created_at: new Date().toISOString() });
  registerChannelAdapter('chat', { factory: () => chatAdapter(), defaults });
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
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('inbound from the bound surface', () => {
  it("lands in the sandbox's coding session — no mention needed, threads ignored, no second group, no card", async () => {
    // As `sandboxes new` does: the coding session exists before the bind.
    await resolveSandboxSession(GROUP.id);
    await bindSessionSurface({ group: GROUP, channelType: 'chat', provider: provider() });

    await fromSurface('m1', 'build me the status page');

    const sandbox = await findSandboxSessions(GROUP.id);
    expect(sandbox).toHaveLength(1);
    // The one session the group holds: the coding session, not a chat session per thread.
    expect((await getSessionsByAgentGroup(GROUP.id)).map((s) => s.id)).toEqual([sandbox[0].id]);
    const rows = inboundRows(sandbox[0].id);
    // The router stamps the agent group onto the id (one row per agent it fans to).
    expect(rows.map((r) => r.id)).toEqual(['m1:ag-route-1']);
    // The reply address is the surface at top level: the wiring runs threads off.
    expect(rows[0]).toMatchObject({ platform_id: 'chat:C1', thread_id: null });

    expect(await getMessagingGroupsByChannel('chat')).toHaveLength(1);
    expect(await getDb().get('SELECT 1 AS x FROM pending_channel_approvals')).toBeUndefined();
  });

  it('a conversation the adapter registered first is adopted by the bind and routes the same way', async () => {
    // The bot was invited and mentioned before the host bound: the router's
    // auto-create ran (this is exactly its row) and a card went out.
    await createMessagingGroup({
      id: 'mg-adapter',
      channel_type: 'chat',
      platform_id: 'chat:C1',
      instance: 'chat',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: new Date().toISOString(),
    });
    await getDb().run(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at, title, question, options_json)
       VALUES ('mg-adapter', 'ag-route-1', '{}', 'chat:U1', '2026-09-12T00:00:00.000Z', 'New channel', 'Connect?', '[]')`,
    );

    await resolveSandboxSession(GROUP.id);
    const bound = await bindSessionSurface({ group: GROUP, channelType: 'chat', provider: provider() });
    expect(bound?.row.messaging_group_id).toBe('mg-adapter');

    await fromSurface('m2', 'hello again');
    const sandbox = await findSandboxSessions(GROUP.id);
    expect(inboundRows(sandbox[0].id).map((r) => r.id)).toEqual(['m2:ag-route-1']);
    expect(await getMessagingGroupsByChannel('chat')).toHaveLength(1);
    expect(await getDb().get('SELECT 1 AS x FROM pending_channel_approvals')).toBeUndefined();
  });

  it('a message in a spelling the adapter never uses (the bare id) matches nothing — the regression this pins', async () => {
    await resolveSandboxSession(GROUP.id);
    await bindSessionSurface({ group: GROUP, channelType: 'chat', provider: provider() });
    await routeInbound({
      channelType: 'chat',
      platformId: 'C1',
      threadId: null,
      message: {
        id: 'm3',
        kind: 'chat-sdk',
        content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text: 'lost' }),
        timestamp: new Date().toISOString(),
        isMention: false,
        isGroup: true,
      },
    });
    const sandbox = await findSandboxSessions(GROUP.id);
    expect(inboundRows(sandbox[0].id)).toEqual([]);
  });
});
