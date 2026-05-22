/**
 * Integration tests for the unknown-sender request_approval flow
 * (ACTION-ITEMS item 5).
 *
 * Covers:
 *  - request_approval policy fires `requestSenderApproval` on first unknown
 *    message from a sender
 *  - In-flight dedup: second message from the same sender while pending is
 *    silently dropped (no second card, no second row)
 *  - Approve path: member added, original message replayed via routeInbound,
 *    container woken
 *  - Deny path: pending row deleted, no member added
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter — record card deliveries for assertions.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: deliverMock,
  }),
}));

// Mock ensureUserDm to return the approver's existing messaging group
// instead of hitting a real openDM RPC.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    const row = getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
    return row;
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-sender-approval' };
});

const TEST_DIR = '/tmp/nanoclaw-test-sender-approval';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  // Side-effect imports: register hooks (permissions module) AFTER the
  // mocks are in place so the access gate / response handler pick up the
  // mocked delivery + user-dm helpers.
  await import('./index.js');

  // Fixtures: agent group, messaging group with request_approval, wiring,
  // owner + DM messaging group for approver delivery.
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });

  createMessagingGroup({
    id: 'mg-chat',
    channel_type: 'telegram',
    platform_id: 'chat-123',
    name: 'Group Chat',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-chat',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  // Owner user + their DM messaging group (pickApprover + ensureUserDm target).
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  deliverMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function stranger(text: string) {
  return {
    channelType: 'telegram',
    platformId: 'chat-123',
    threadId: null,
    message: {
      id: `stranger-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        senderId: 'stranger-tg-id',
        senderName: 'Stranger',
        text,
      }),
      timestamp: now(),
    },
  };
}

describe('unknown-sender request_approval flow', () => {
  it('delivers an approval card on first unknown message', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(stranger('hi'));

    // Wait for the fire-and-forget requestSenderApproval to resolve.
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channel, platformId, thread, kind, content] = deliverMock.mock.calls[0];
    expect(channel).toBe('telegram');
    expect(platformId).toBe('dm-owner'); // delivered to owner's DM
    expect(thread).toBeNull();
    expect(kind).toBe('chat-sdk');
    const payload = JSON.parse(content as string);
    expect(payload.type).toBe('ask_question');
    expect(payload.questionId).toMatch(/^nsa-/);

    const { getDb } = await import('../../db/connection.js');
    const rows = getDb().prepare('SELECT * FROM pending_sender_approvals').all();
    expect(rows).toHaveLength(1);
  });

  it('dedups a second message from the same stranger while pending', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(stranger('hello'));
    await new Promise((r) => setTimeout(r, 10));
    await routeInbound(stranger('are you there?'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('approve → adds member and replays the original message', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { wakeContainer } = await import('../../container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(stranger('please let me in'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    // Fire the approve click through the response-handler chain.
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        // Chat SDK's onAction surfaces the raw platform userId (e.g. Telegram
        // chat id). The permissions handler namespaces it with channelType to
        // match users(id).
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Member row added for the stranger against the wired agent group.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('telegram:stranger-tg-id', 'ag-1');
    expect(member).toBeDefined();

    // Pending row cleared.
    const stillPending = getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number };
    expect(stillPending.c).toBe(0);

    // Message replayed + container woken.
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('deny → deletes the pending row without adding a member', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(stranger('hello'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'reject',
        userId: 'owner', // raw platform id — handler namespaces with channelType
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('telegram:stranger-tg-id', 'ag-1');
    expect(member).toBeUndefined();
  });

  it('rejects clicks from an unauthorized user (prevents self-admit via forwarded card)', async () => {
    // Stranger triggers the approval flow; card goes to the owner.
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(stranger('can I play'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    // A random user (not the stranger, not the owner, not an admin) tries to
    // click the approval — e.g. they got the card forwarded. Should be
    // rejected without admitting them.
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        userId: 'random-bystander', // not owner, not admin
        channelType: 'telegram',
        platformId: 'dm-random',
        threadId: null,
      });
      if (claimed) break;
    }

    // No member added for the stranger.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('telegram:stranger-tg-id', 'ag-1');
    expect(member).toBeUndefined();

    // Pending row is still there — a legitimate approver can still act on it.
    const stillPending = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number })
      .c;
    expect(stillPending).toBe(1);
  });

  it('accepts a click from a global admin even if they are not the designated approver', async () => {
    // Pre-seed a separate admin user so we can click as them.
    upsertUser({ id: 'telegram:admin-bob', kind: 'telegram', display_name: 'Bob', created_at: now() });
    grantRole({
      user_id: 'telegram:admin-bob',
      role: 'admin',
      agent_group_id: null,
      granted_by: 'telegram:owner',
      granted_at: now(),
    });

    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(stranger('knock knock'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    // Admin clicks approve (not the designated approver, which was owner).
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        userId: 'admin-bob',
        channelType: 'telegram',
        platformId: 'dm-bob',
        threadId: null,
      });
      if (claimed) break;
    }

    // Stranger admitted thanks to the admin's authority.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('telegram:stranger-tg-id', 'ag-1');
    expect(member).toBeDefined();
  });
});
