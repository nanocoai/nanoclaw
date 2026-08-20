/**
 * Integration tests for the unknown-channel registration flow (ACTION-ITEMS
 * item 22).
 *
 * Covers:
 *  - Mention on an unwired channel fires an owner-approval card
 *  - DM on an unwired channel fires a card (engage_mode will default to pattern='.')
 *  - In-flight dedup: second mention while a card is pending doesn't spam
 *  - Approve: wiring created with correct defaults, triggering sender added
 *    as member, replay wakes the container
 *  - Deny: messaging_groups.denied_at set, future mentions drop silently
 *  - Unauthorized clicker is rejected (same pattern as sender-approval)
 *  - No-owner install: no card, no row
 *  - No agent groups configured: no card, no row
 */
import fs from 'fs';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { AGENT_ACCESS_SCOPE_WARNING, createNewAgentGroup } from './channel-approval.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import type { ChannelDefaults } from '../../channels/adapter.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Registration-tier declaration for the fixture channel — a threaded platform
// whose declared defaults match the historical card-flow behavior
// (mention-sticky groups, pattern '.' DMs). Without it, the no-live-adapter
// fallback resolves threads=false and coerces sticky → mention.
// Registry maps are module-global; keep channel names unique per test file.
const telegramDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('telegram', { factory: () => null, defaults: telegramDefaults });

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

// Mock ensureUserDm — look up the owner's preconfigured DM row instead of
// hitting a real openDM RPC.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    const row = await getDb().get(
      `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      userId,
    );
    return row;
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-channel-approval',
    GROUPS_DIR: '/tmp/nanoclaw-test-channel-approval/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-channel-approval';

function now() {
  return new Date().toISOString();
}

async function countRows(sql: string, ...params: unknown[]): Promise<number> {
  return (await getDb().get<{ c: number }>(sql, ...params))!.c;
}

async function expectAsyncDelivery(action: () => Promise<void>): Promise<void> {
  const previousDeliveryCount = deliverMock.mock.calls.length;
  await action();
  await vi.waitFor(() => {
    expect(deliverMock.mock.calls.length).toBeGreaterThan(previousDeliveryCount);
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await import('./index.js'); // register hooks

  // Base fixtures: one agent group + owner with a DM on 'telegram'.
  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });

  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });

  // Pre-seed owner's DM messaging group + user_dms mapping.
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run(
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
     VALUES (?, ?, ?, ?)`,
    'telegram:owner',
    'telegram',
    'mg-dm-owner',
    now(),
  );

  deliverMock.mockClear();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function groupMention(platformId: string, text = '@bot hello') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: 'thread-1',
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text }),
      timestamp: now(),
      isMention: true,
      isGroup: true, // group context comes from the adapter flag, never threadId
    },
  };
}

function dmEvent(platformId: string, text = 'hello') {
  return {
    channelType: 'telegram',
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({ senderId: 'stranger', senderName: 'Stranger', text }),
      timestamp: now(),
      isMention: true, // DM bridge sets isMention=true
    },
  };
}

describe('unknown-channel registration flow', () => {
  it('delivers an approval card on mention into an unwired group', async () => {
    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(groupMention('chat-new')));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channel, platformId, thread, kind, content] = deliverMock.mock.calls[0];
    expect(channel).toBe('telegram');
    expect(platformId).toBe('dm-owner'); // delivered to owner's DM
    expect(thread).toBeNull();
    expect(kind).toBe('chat-sdk');
    const payload = JSON.parse(content as string);
    expect(payload.type).toBe('ask_question');
    // Card tells the approver the resolved engage rule.
    expect(payload.question).toContain('will respond to @-mentions in this group');
    expect(payload.question).toContain(AGENT_ACCESS_SCOPE_WARNING);
    // Single-agent card offers a direct "Connect to <name>" button.
    const connectOption = payload.options.find((o: { value: string }) => o.value.startsWith('connect:'));
    expect(connectOption).toBeDefined();
    expect(connectOption.label).toContain('Andy');

    const rows = await getDb().all<{ messaging_group_id: string }>('SELECT * FROM pending_channel_approvals');
    expect(rows).toHaveLength(1);
  });

  it('delivers a card on DM too (non-threaded event)', async () => {
    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(dmEvent('dm-new-user')));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string) as { question: string };
    expect(payload.question).toContain('will respond to all messages');
    const count = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(count).toBe(1);
  });

  it('dedups a second mention while the card is pending', async () => {
    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(groupMention('chat-busy')));
    await routeInbound(groupMention('chat-busy', '@bot still here'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const count = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(count).toBe(1);
  });

  it('approve → creates wiring, admits triggering sender, replays', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { wakeContainer } = await import('../../container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-approve')));

    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;
    expect(pending).toBeDefined();

    // Owner clicks "Connect to Andy" (single-agent card).
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner', // raw platform id — handler namespaces it
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Wiring created with defaults.
    const mga = (await getDb().get(
      'SELECT * FROM messaging_group_agents WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    )) as {
      engage_mode: string;
      engage_pattern: string | null;
      sender_scope: string;
      ignored_message_policy: string;
      agent_group_id: string;
    };
    expect(mga).toBeDefined();
    expect(mga.engage_mode).toBe('mention-sticky'); // declared group default (threads:true keeps sticky)
    expect(mga.engage_pattern).toBeNull();
    expect(mga.sender_scope).toBe('known');
    expect(mga.ignored_message_policy).toBe('accumulate');
    expect(mga.agent_group_id).toBe('ag-1');

    // Triggering sender auto-admitted so sender_scope='known' doesn't
    // bounce the replay into sender-approval.
    const member = await getDb().get(
      'SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?',
      'telegram:caller',
      'ag-1',
    );
    expect(member).toBeDefined();

    // Pending row cleared and container woken via replay.
    const stillPending = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(stillPending).toBe(0);
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('approve on a DM wires with pattern="." defaults', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await expectAsyncDelivery(() => routeInbound(dmEvent('dm-approve-user')));

    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-1',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    const mga = (await getDb().get(
      'SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    )) as { engage_mode: string; engage_pattern: string };
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
  });

  // WhatsApp-like platform: groups exist but thread ids don't (threadId is
  // always null), and the adapter is undeclared (stale skill-installed copy)
  // so resolution goes through the behavior-faithful fallback. This is the
  // one deliberate behavior change of the defaults work: the old
  // `threadId !== null` heuristic misread these groups as DMs and wired
  // pattern '.'.
  function waGroupMention(platformId: string) {
    return {
      channelType: 'wamock',
      platformId,
      threadId: null,
      message: {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text: '@bot hi' }),
        timestamp: now(),
        isMention: true,
        isGroup: true,
      },
    };
  }

  async function approvePending(agentGroupId = 'ag-1') {
    const { getResponseHandlers } = await import('../../response-registry.js');
    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;
    expect(pending).toBeDefined();
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: `connect:${agentGroupId}`,
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }
    return pending.messaging_group_id;
  }

  it('non-threaded group (isGroup flag, null threadId) wires the GROUP default, sticky coerced to mention', async () => {
    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(waGroupMention('wa-group-1')));

    const mgId = await approvePending();

    const mga = (await getDb().get(
      'SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?',
      mgId,
    )) as { engage_mode: string; engage_pattern: string | null };
    // Faithful fallback group default is mention-sticky, but with no live
    // adapter threads resolve false → coerced to plain mention. NOT the old
    // pattern '.' DM misclassification.
    expect(mga.engage_mode).toBe('mention');
    expect(mga.engage_pattern).toBeNull();
  });

  it('DM on an undeclared channel stays pattern "." through the faithful fallback', async () => {
    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() =>
      routeInbound({
        ...waGroupMention('wa-dm-1'),
        message: { ...waGroupMention('wa-dm-1').message, isGroup: false },
      }),
    );

    const mgId = await approvePending();

    const mga = (await getDb().get(
      'SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE messaging_group_id = ?',
      mgId,
    )) as { engage_mode: string; engage_pattern: string | null };
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
  });

  it('connect-existing and new-agent approve paths produce identical wirings', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    // Path 1: connect to existing agent.
    await expectAsyncDelivery(() => routeInbound(groupMention('chat-path-connect')));
    const mgIdConnect = await approvePending();

    // Path 2: new agent via free-text name reply.
    await expectAsyncDelivery(() => routeInbound(groupMention('chat-path-newagent')));
    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }
    // Owner replies with the agent name in their DM — interceptor wires.
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', text: 'Bravo' }),
        timestamp: now(),
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    const select =
      'SELECT engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority ' +
      'FROM messaging_group_agents WHERE messaging_group_id = ?';
    const viaConnect = await getDb().get(select, mgIdConnect);
    const viaNewAgent = await getDb().get(select, pending.messaging_group_id);
    expect(viaNewAgent).toBeDefined();
    expect(viaNewAgent).toEqual(viaConnect);
  });

  it('deny → sets denied_at; future mentions drop silently without a second card', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-deny')));
    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'reject',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // denied_at set, pending row cleared, no wiring.
    const mg = await getMessagingGroupByPlatform('telegram', 'chat-deny');
    expect(mg?.denied_at).not.toBeNull();
    expect(mg?.denied_at).toBeTruthy();
    const mgaCount = await countRows(
      'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    );
    expect(mgaCount).toBe(0);

    // A follow-up mention on the denied channel: no new card, no new pending row.
    deliverMock.mockClear();
    await routeInbound(groupMention('chat-deny', '@bot please'));
    await new Promise((r) => setTimeout(r, 10));
    expect(deliverMock).not.toHaveBeenCalled();
    const stillPending = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(stillPending).toBe(0);
  });

  it('rejects clicks from an unauthorized user (prevents self-admit via forwarded card)', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-unauth')));
    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'approve',
        userId: 'random-bystander',
        channelType: 'telegram',
        platformId: 'dm-random',
        threadId: null,
      });
      if (claimed) break;
    }

    // No wiring created, pending row preserved so a real approver can act on it.
    const mgaCount = await countRows(
      'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    );
    expect(mgaCount).toBe(0);
    const stillPending = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(stillPending).toBe(1);
  });

  it('does not let a scoped admin connect an unknown channel to another agent group', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await createAgentGroup({ id: 'ag-2', name: 'Betty', folder: 'betty', agent_provider: null, created_at: now() });
    await upsertUser({
      id: 'telegram:scoped-admin',
      kind: 'telegram',
      display_name: 'Scoped Admin',
      created_at: now(),
    });
    await grantRole({
      user_id: 'telegram:scoped-admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: 'telegram:owner',
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-dm-scoped-admin',
      channel_type: 'telegram',
      platform_id: 'dm-scoped-admin',
      name: 'Scoped Admin DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await getDb().run(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
      'telegram:scoped-admin',
      'telegram',
      'mg-dm-scoped-admin',
      now(),
    );

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-scoped-cross-group')));

    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;
    expect(pending).toBeDefined();
    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(deliverMock.mock.calls[0][1]).toBe('dm-scoped-admin');

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'choose_existing',
        userId: 'scoped-admin',
        channelType: 'telegram',
        platformId: 'dm-scoped-admin',
        threadId: null,
      });
      if (claimed) break;
    }

    const followupPayload = JSON.parse(deliverMock.mock.calls[1][4] as string) as {
      question: string;
      options: Array<{ label: string; value: string }>;
    };
    expect(followupPayload.question).toContain(AGENT_ACCESS_SCOPE_WARNING);
    expect(followupPayload.options.map((option) => option.value)).toContain('connect:ag-1');
    expect(followupPayload.options.map((option) => option.value)).not.toContain('connect:ag-2');

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'connect:ag-2',
        userId: 'scoped-admin',
        channelType: 'telegram',
        platformId: 'dm-scoped-admin',
        threadId: null,
      });
      if (claimed) break;
    }

    const mgaCount = await countRows(
      'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    );
    expect(mgaCount).toBe(0);
    const stillPending = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(stillPending).toBe(1);
  });

  it('create new agent: the free-text name reply creates the group and wires the channel', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-create-new')));
    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;

    // Owner clicks "Connect new agent" → name prompt lands in their DM.
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Owner replies with the agent name in the same DM — the interceptor
    // captures it and creates.
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: 'name-reply-1',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'Newbie' }),
        timestamp: now(),
      },
    });

    const created = await getDb().get<{ id: string }>("SELECT id FROM agent_groups WHERE name = 'Newbie'");
    expect(created).toBeDefined();
    const mgaCount = await countRows(
      'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?',
      pending.messaging_group_id,
      created!.id,
    );
    expect(mgaCount).toBe(1);
    const stillPending = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(stillPending).toBe(0);
  });

  it('a name reply after the registration vanished is consumed without creating anything', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-vanished')));
    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.messaging_group_id,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // The registration disappears between the click and the reply (rejected
    // from another card, group delete cascade, …) — the interceptor no
    // longer finds a pending registration, so the reply must not create.
    await getDb().run('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?', pending.messaging_group_id);

    const agentGroupsBefore = await countRows('SELECT COUNT(*) AS c FROM agent_groups');
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id: 'name-reply-2',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'Ghost' }),
        timestamp: now(),
      },
    });

    const agentGroupsAfter = await countRows('SELECT COUNT(*) AS c FROM agent_groups');
    expect(agentGroupsAfter).toBe(agentGroupsBefore);
    const mgaCount = await countRows('SELECT COUNT(*) AS c FROM messaging_group_agents');
    expect(mgaCount).toBe(0);
  });
});

describe('no-owner / no-agent failure modes', () => {
  it('no owner → no card, no pending row (fresh-install bootstrap path)', async () => {
    // Wipe the owner grant set up in the outer beforeEach.
    await getDb().run('DELETE FROM user_roles');

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noowner'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const count = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(count).toBe(0);
  });

  it('no agent groups → no card, no pending row', async () => {
    // Drop foreign-key-dependent rows first, then the agent group itself.
    await getDb().run('DELETE FROM user_roles');
    await getDb().run('DELETE FROM agent_groups');

    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-noagent'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).not.toHaveBeenCalled();
    const count = await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(count).toBe(0);
  });
});

describe('createNewAgentGroup — disk-aware folder dedupe (A4)', () => {
  it('skips deleted-group residue on disk and mints the next suffix', async () => {
    // groups/my-agent exists on disk but no DB row claims it — exactly the
    // state `ncl groups delete` leaves behind. The dedupe loop must treat
    // disk presence as taken (matching templates/create-agent.ts) and mint
    // my-agent-2, never adopt the residue.
    const residue = path.join(TEST_DIR, 'groups', 'my-agent');
    fs.mkdirSync(residue, { recursive: true });
    fs.writeFileSync(path.join(residue, 'memory.md'), 'old group memory\n');

    const ag = await createNewAgentGroup('My Agent');

    expect(ag.folder).toBe('my-agent-2');
    // Residue untouched.
    expect(fs.readFileSync(path.join(residue, 'memory.md'), 'utf8')).toBe('old group memory\n');
  });
});
