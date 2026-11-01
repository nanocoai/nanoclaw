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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations, getDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  AGENT_ACCESS_SCOPE_WARNING,
  createNewAgentGroup,
  describeResolvedRule,
  setChannelApprovalUndeliverableHandler,
  type ChannelApprovalUndeliverable,
} from './channel-approval.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ChannelAdapter, ChannelDefaults, ResolvedConversation } from '../../channels/adapter.js';
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

const resolveConversationMock = vi.fn(async (_platformId: string): Promise<ResolvedConversation | null> => null);
const resolveChannelNameMock = vi.fn(async (_platformId: string): Promise<string | null> => null);
const slackAdapter: ChannelAdapter = {
  name: 'slack',
  channelType: 'slack',
  supportsThreads: true,
  async setup() {},
  async teardown() {},
  isConnected: () => true,
  async deliver() {
    return undefined;
  },
  resolveConversation: resolveConversationMock,
  resolveChannelName: resolveChannelNameMock,
  defaults: telegramDefaults,
};
registerChannelAdapter('slack', { factory: () => slackAdapter, defaults: telegramDefaults });
registerChannelAdapter('namepattern', {
  factory: () => null,
  defaults: {
    ...telegramDefaults,
    group: { ...telegramDefaults.group, engageMode: 'pattern', engagePattern: '\\b{name}\\b' },
  },
});

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
  // Stub the registry so modules that self-register on import (typing,
  // scheduling, self-mod, agent-to-agent) don't crash at module-load
  // under this partial mock. Tests here don't exercise delivery actions.
  registerDeliveryAction: vi.fn(),
}));

// A pass-through newGroupFolder a test can hold, to land a click while a name reply is being checked.
const folderGate = vi.hoisted(() => ({ hold: null as Promise<void> | null, entered: false }));
vi.mock('../../group-folder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../group-folder.js')>();
  return {
    ...actual,
    newGroupFolder: async (base: string) => {
      folderGate.entered = true;
      if (folderGate.hold) await folderGate.hold;
      return actual.newGroupFolder(base);
    },
  };
});

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

beforeAll(async () => {
  await initChannelAdapters(() => ({
    onInbound() {},
    onInboundEvent() {},
    onMetadata() {},
    onAction() {},
  }));
});

afterAll(async () => {
  await teardownChannelAdapters();
});

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
  resolveConversationMock.mockReset().mockResolvedValue(null);
  resolveChannelNameMock.mockReset().mockResolvedValue(null);
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

function slackGroupMention(platformId: string) {
  return {
    channelType: 'slack',
    platformId,
    threadId: 'thread-1',
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat-sdk' as const,
      content: JSON.stringify({
        senderId: 'U_ALICE',
        sender: 'Alice Doe',
        senderName: 'Alice Doe',
        text: '<@bot> hello',
      }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
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
    expect(payload.title).toBe('📣 Bot mentioned in new channel');
    expect(payload.question).toBe(
      `"Caller" mentioned your bot in a telegram channel. If connected, the agent will respond to @-mentions in this group. ${AGENT_ACCESS_SCOPE_WARNING} How would you like to handle this channel?`,
    );
    // Card tells the approver the resolved engage rule.
    expect(payload.question).toContain('will respond to @-mentions in this group');
    expect(payload.question).toContain(AGENT_ACCESS_SCOPE_WARNING);
    // Single-agent card offers a direct "Connect to <name>" button.
    const connectOption = payload.options.find((o: { value: string }) => o.value.startsWith('connect:'));
    expect(connectOption).toBeDefined();
    expect(connectOption.label).toContain('Andy');
    expect(connectOption.selectedLabel).toBe('✅ Connected to "Andy"');

    const rows = await getDb().all<{ messaging_group_id: string }>('SELECT * FROM pending_channel_approvals');
    expect(rows).toHaveLength(1);
  });

  it('renders Slack MPDMs as participant-based group chats without leaking the internal slug', async () => {
    resolveConversationMock.mockResolvedValueOnce({
      type: 'group_dm',
      name: null,
      participantNames: ['alice', 'Bob', 'Carol'],
      participantIds: ['U_ALICE', 'U_BOB', 'U_CAROL'],
    });
    resolveChannelNameMock.mockResolvedValueOnce('mpdm-alice--bob--carol-1');

    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(slackGroupMention('mpdm-alice--bob--carol-1')));

    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string) as { title: string; question: string };
    expect(payload.title).toBe('👥 Bot mentioned in new group chat');
    expect(payload.question).toContain(
      '"Alice Doe" mentioned your bot in a group chat with "Bob" and "Carol" on slack.',
    );
    expect(payload.question).toContain(AGENT_ACCESS_SCOPE_WARNING);
    expect(payload.question).toContain('How would you like to handle this group chat?');
    expect(payload.question).not.toContain('mpdm-');
    expect(resolveConversationMock).toHaveBeenCalledWith('mpdm-alice--bob--carol-1');
  });

  it('persists a rich-resolved Slack channel name and skips the legacy resolver', async () => {
    resolveConversationMock.mockResolvedValueOnce({ type: 'channel', name: 'growth-team' });
    resolveChannelNameMock.mockResolvedValueOnce('legacy-name');

    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(slackGroupMention('C_GROWTH')));

    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string) as { title: string; question: string };
    expect(payload.title).toBe('📣 Bot mentioned in new channel');
    expect(payload.question).toContain('"Alice Doe" mentioned your bot in "growth-team" on slack.');
    expect(payload.question).toContain('How would you like to handle this channel?');
    expect(resolveChannelNameMock).not.toHaveBeenCalled();
    expect((await getMessagingGroupByPlatform('slack', 'C_GROWTH'))?.name).toBe('growth-team');
  });

  it('delivers a card on DM too (non-threaded event)', async () => {
    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(dmEvent('dm-new-user')));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string) as { question: string };
    expect(payload.question).toContain('will respond to all messages');
    expect(payload.question).toContain(AGENT_ACCESS_SCOPE_WARNING);
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

    // Existing agent already has a chat in the historical `shared` mode.
    // Approval must behave like Dashboard Add Chat: add the new chat as
    // agent-shared and flip this sibling binding into the same regime.
    await createMessagingGroup({
      id: 'mg-existing-chat',
      channel_type: 'telegram',
      platform_id: 'chat-existing',
      name: 'Existing chat',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-existing-chat',
      messaging_group_id: 'mg-existing-chat',
      agent_group_id: 'ag-1',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
    // The same agent's private DM must keep its own session: a channel
    // approval never merges a DM into the agent-shared channel session.
    await createMessagingGroup({
      id: 'mg-existing-dm',
      channel_type: 'telegram',
      platform_id: 'dm-existing',
      name: 'Existing DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-existing-dm',
      messaging_group_id: 'mg-existing-dm',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

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
      session_mode: string;
      agent_group_id: string;
    };
    expect(mga).toBeDefined();
    expect(mga.engage_mode).toBe('mention-sticky'); // declared group default (threads:true keeps sticky)
    expect(mga.engage_pattern).toBeNull();
    expect(mga.sender_scope).toBe('known');
    expect(mga.ignored_message_policy).toBe('accumulate');
    expect(mga.session_mode).toBe('agent-shared');
    expect(mga.agent_group_id).toBe('ag-1');
    const sibling = (await getDb().get<{ session_mode: string }>(
      'SELECT session_mode FROM messaging_group_agents WHERE id = ?',
      'mga-existing-chat',
    ))!;
    expect(sibling.session_mode).toBe('agent-shared');
    const dmSibling = (await getDb().get<{ session_mode: string }>(
      'SELECT session_mode FROM messaging_group_agents WHERE id = ?',
      'mga-existing-dm',
    ))!;
    expect(dmSibling.session_mode).toBe('shared');

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

  it('rolls back the entire approval commit when sender admission fails', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { wakeContainer } = await import('../../container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await createMessagingGroup({
      id: 'mg-rollback-sibling',
      channel_type: 'telegram',
      platform_id: 'rollback-sibling',
      name: 'Rollback sibling',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-rollback-sibling',
      messaging_group_id: 'mg-rollback-sibling',
      agent_group_id: 'ag-1',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-rollback')));
    const pending = (await getDb().get<{ messaging_group_id: string }>(
      'SELECT messaging_group_id FROM pending_channel_approvals',
    ))!;

    // Fail after the wiring/destination insert and sibling-mode update. The
    // transaction must unwind all of them and retain the approval for retry.
    await getDb().exec(`CREATE TRIGGER fail_channel_approval_member
      BEFORE INSERT ON agent_group_members
      WHEN NEW.user_id = 'telegram:caller'
      BEGIN
        SELECT RAISE(ABORT, 'forced member failure');
      END`);

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

    const wiringCount = await countRows(
      'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    );
    const destinationCount = await countRows(
      "SELECT COUNT(*) AS c FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?",
      pending.messaging_group_id,
    );
    const sibling = (await getDb().get<{ session_mode: string }>(
      'SELECT session_mode FROM messaging_group_agents WHERE id = ?',
      'mga-rollback-sibling',
    ))!;
    const pendingCount = await countRows(
      'SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    );
    const memberCount = await countRows(
      "SELECT COUNT(*) AS c FROM agent_group_members WHERE user_id = 'telegram:caller' AND agent_group_id = 'ag-1'",
    );

    expect(wiringCount).toBe(0);
    expect(destinationCount).toBe(0);
    expect(sibling.session_mode).toBe('shared');
    expect(pendingCount).toBe(1);
    expect(memberCount).toBe(0);
    expect(wakeContainer).not.toHaveBeenCalled();
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
      'SELECT engage_mode, engage_pattern, session_mode FROM messaging_group_agents WHERE messaging_group_id = ?',
      pending.messaging_group_id,
    )) as { engage_mode: string; engage_pattern: string; session_mode: string };
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
    // An approved DM keeps its own session; it never joins agent-shared.
    expect(mga.session_mode).toBe('shared');
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

  async function startNamePrompt(chatId: string) {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    await expectAsyncDelivery(() => routeInbound(groupMention(chatId)));
    const pending = (await getDb().get<{ messaging_group_id: string; options_json: string; title: string }>(
      'SELECT messaging_group_id, options_json, title FROM pending_channel_approvals',
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
    return { routeInbound, pending };
  }

  function ownerDm(id: string, text: string) {
    return {
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id,
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text }),
        timestamp: now(),
      },
    };
  }

  it('create new agent: the name prompt offers cancel', async () => {
    await startNamePrompt('chat-prompt-text');
    const prompt = deliverMock.mock.calls.find((c) => c[1] === 'dm-owner' && String(c[4]).includes('name for'));
    expect(JSON.parse(String(prompt![4]))).toEqual({
      text: "Reply with the name for your new agent (or 'cancel' to go back):",
    });
  });

  it('isAbortReply matches only the bare abort words, not names that contain them', async () => {
    const { isAbortReply } = await import('./index.js');
    for (const abort of ['cancel', ' Cancel. ', 'GO BACK', 'go   back!', 'Back?', 'stop']) {
      expect(isAbortReply(abort), abort).toBe(true);
    }
    for (const name of ['Stop Sign Bot', 'Backend', 'Cancellation Bot', 'Stop2', 'Back 4', 'Jon']) {
      expect(isAbortReply(name), name).toBe(false);
    }
  });

  it.each([' Cancel. ', 'go back', 'BACK!', 'stop'])(
    'create new agent: %j at the name prompt aborts, creates and wires nothing, and re-shows the choices',
    async (reply) => {
      const agentsBefore = await countRows('SELECT COUNT(*) AS c FROM agent_groups');
      const { routeInbound, pending } = await startNamePrompt(`chat-cancel-${reply.trim()}`);
      deliverMock.mockClear();

      await routeInbound(ownerDm(`cancel-${reply}`, reply));

      expect(await countRows('SELECT COUNT(*) AS c FROM agent_groups')).toBe(agentsBefore);
      expect(
        await countRows(
          'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?',
          pending.messaging_group_id,
        ),
      ).toBe(0);
      expect(
        await countRows(
          'SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE messaging_group_id = ?',
          pending.messaging_group_id,
        ),
      ).toBe(1);
      expect(await countRows("SELECT COUNT(*) AS c FROM agent_group_members WHERE user_id LIKE '%caller'")).toBe(0);

      // Only the approver hears back: the original choices, same question id.
      expect(deliverMock).toHaveBeenCalledTimes(1);
      const [channelType, platformId, , , content] = deliverMock.mock.calls[0]!;
      expect([channelType, platformId]).toEqual(['telegram', 'dm-owner']);
      const card = JSON.parse(String(content)) as Record<string, unknown>;
      expect(card).toMatchObject({
        type: 'ask_question',
        questionId: pending.messaging_group_id,
        title: pending.title,
        options: JSON.parse(pending.options_json),
      });

      // The next reply is ordinary chat, not a name: picking again still works.
      deliverMock.mockClear();
      await routeInbound(ownerDm(`after-${reply}`, 'Jon'));
      expect(await countRows("SELECT COUNT(*) AS c FROM agent_groups WHERE name = 'Jon'")).toBe(0);
    },
  );

  it('create new agent: confirms to the approver with instance in the instance slot, not inReplyTo', async () => {
    // Regression (2026-10-16): the confirmation passed `event.instance` as
    // the 7th positional arg (inReplyTo). Discord rejected the reply
    // reference ("discord" is not a snowflake) and the error was swallowed,
    // so the approver saw nothing after typing the name.
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await expectAsyncDelivery(() => routeInbound(groupMention('chat-confirm')));
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

    deliverMock.mockClear();
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      instance: 'telegram',
      message: {
        id: 'name-reply-confirm',
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text: 'Jon' }),
        timestamp: now(),
      },
    });

    const confirm = await vi.waitFor(() => {
      const call = deliverMock.mock.calls.find(
        (c) => c[1] === 'dm-owner' && String(c[4]).includes('created and connected'),
      );
      expect(call).toBeDefined();
      return call!;
    });
    expect(confirm[0]).toBe('telegram');
    expect(confirm[6]).toBeUndefined(); // inReplyTo
    expect(confirm[10]).toBe('telegram'); // instance
  });

  it('a name reply after the registration vanished creates nothing and clears the prompt', async () => {
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
    expect(await countRows('SELECT COUNT(*) AS c FROM pending_name_inputs')).toBe(0);
  });

  /** An unwired group chat with its registration card pending; returns its messaging group id. */
  async function pendingRegistration(platformId: string): Promise<string> {
    const { routeInbound } = await import('../../router.js');
    await expectAsyncDelivery(() => routeInbound(groupMention(platformId)));
    return (await getMessagingGroupByPlatform('telegram', platformId))!.id;
  }

  /** The owner clicks "Connect new agent" on that card; the name prompt lands in their DM. */
  async function clickNewAgent(messagingGroupId: string): Promise<void> {
    const { getResponseHandlers } = await import('../../response-registry.js');
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: messagingGroupId,
        value: 'new_agent',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }
  }

  async function nameReply(id: string, text: string): Promise<void> {
    const { routeInbound } = await import('../../router.js');
    await routeInbound({
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      message: {
        id,
        kind: 'chat' as const,
        content: JSON.stringify({ senderId: 'owner', senderName: 'Owner', text }),
        timestamp: now(),
      },
    });
  }

  async function expectCreatedAndWired(name: string, messagingGroupId: string): Promise<void> {
    const created = await getDb().get<{ id: string }>('SELECT id FROM agent_groups WHERE name = ?', name);
    expect(created).toBeDefined();
    expect(
      await countRows(
        'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?',
        messagingGroupId,
        created!.id,
      ),
    ).toBe(1);
  }

  it('a name too long for a folder creates nothing and asks again; the next name is created', async () => {
    const mgId = await pendingRegistration('chat-long-name');
    await clickNewAgent(mgId);

    const longName = 'a'.repeat(70);
    const agentGroupsBefore = await countRows('SELECT COUNT(*) AS c FROM agent_groups');
    await nameReply('name-reply-long', longName);

    expect(await countRows('SELECT COUNT(*) AS c FROM agent_groups')).toBe(agentGroupsBefore);
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', longName))).toBe(false);
    expect(await countRows('SELECT COUNT(*) AS c FROM messaging_group_agents')).toBe(0);
    expect(await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(1);
    const refusal = JSON.parse(deliverMock.mock.calls.at(-1)![4] as string).text as string;
    expect(refusal).toBe(
      `⚠️ Cannot create agent "${longName}": Invalid group folder "${longName}" — too long: 70 characters, at most 63. ` +
        'Nothing was created. Reply with another name:',
    );

    // The prompt is re-armed: the next reply is taken as the name.
    await nameReply('name-reply-retry', 'Newbie');

    await expectCreatedAndWired('Newbie', mgId);
  });

  it("a failed re-prompt leaves another channel's newer name prompt in place", async () => {
    const firstMgId = await pendingRegistration('chat-race-first');
    const secondMgId = await pendingRegistration('chat-race-second');
    await clickNewAgent(firstMgId);

    // Hold the refusal's re-prompt in flight while the owner starts the second channel.
    let failRePrompt: ((err: Error) => void) | undefined;
    deliverMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRePrompt = reject;
        }),
    );
    const refused = nameReply('name-reply-race', 'a'.repeat(70));
    await vi.waitFor(() => expect(failRePrompt).toBeDefined());
    await clickNewAgent(secondMgId);
    failRePrompt!(new Error('delivery failed'));
    await refused;

    await nameReply('name-reply-second', 'Newbie');

    await expectCreatedAndWired('Newbie', secondMgId);
  });

  it('a late failure of an earlier re-prompt leaves the newer one in place', async () => {
    const mgId = await pendingRegistration('chat-late-failure');
    await clickNewAgent(mgId);

    // The first refusal's delivery hangs; the approver tries again and that refusal arrives.
    let failFirst: ((err: Error) => void) | undefined;
    deliverMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failFirst = reject;
        }),
    );
    const first = nameReply('name-reply-late-1', 'a'.repeat(70));
    await vi.waitFor(() => expect(failFirst).toBeDefined());
    await nameReply('name-reply-late-2', 'Global');
    failFirst!(new Error('delivery failed'));
    await first;

    await nameReply('name-reply-late-3', 'Newbie');

    await expectCreatedAndWired('Newbie', mgId);
  });

  it('a prompt opened for another channel while a name is checked is not replaced', async () => {
    const firstMgId = await pendingRegistration('chat-held-first');
    const secondMgId = await pendingRegistration('chat-held-second');
    await clickNewAgent(firstMgId);

    let release: (() => void) | undefined;
    folderGate.entered = false;
    folderGate.hold = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const refused = nameReply('name-reply-held', 'a'.repeat(70));
      await vi.waitFor(() => expect(folderGate.entered).toBe(true));
      await clickNewAgent(secondMgId);
      release!();
      await refused;
    } finally {
      folderGate.hold = null;
    }
    // The refusal for the first name no longer asks for another: the next reply is the second channel's.
    const texts = deliverMock.mock.calls.map((c) => JSON.parse(c[4] as string).text as string | undefined);
    const refusal = texts.find((text) => text?.startsWith('⚠️ Cannot create agent'));

    await nameReply('name-reply-held-second', 'Newbie');

    await expectCreatedAndWired('Newbie', secondMgId);
    expect(refusal).toMatch(/Nothing was created\.$/);
  });

  it("a late failure of the first name prompt leaves a refused name's re-arm in place", async () => {
    const mgId = await pendingRegistration('chat-late-prompt');
    let failPrompt: ((err: Error) => void) | undefined;
    deliverMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failPrompt = reject;
        }),
    );
    const click = clickNewAgent(mgId);
    await vi.waitFor(() => expect(failPrompt).toBeDefined());
    await nameReply('name-reply-late-prompt-1', 'a'.repeat(70));
    failPrompt!(new Error('delivery failed'));
    await click;

    await nameReply('name-reply-late-prompt-2', 'Newbie');

    await expectCreatedAndWired('Newbie', mgId);
  });
});

describe('confirmed delivery: fall through approvers, then the host fallback', () => {
  const undeliverable: ChannelApprovalUndeliverable[] = [];

  beforeEach(async () => {
    undeliverable.length = 0;
    setChannelApprovalUndeliverableHandler((info) => {
      undeliverable.push(info);
    });
    // A second owner, granted later, reachable on Discord.
    await upsertUser({ id: 'discord:owner2', kind: 'discord', display_name: 'Owner Two', created_at: now() });
    await grantRole({
      user_id: 'discord:owner2',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: new Date(Date.now() + 1000).toISOString(),
    });
    await createMessagingGroup({
      id: 'mg-dm-owner2',
      channel_type: 'discord',
      platform_id: 'dm-owner2',
      name: 'Owner Two DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await getDb().run(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`,
      'discord:owner2',
      'discord',
      'mg-dm-owner2',
      now(),
    );
  });

  afterEach(() => {
    setChannelApprovalUndeliverableHandler(null);
    deliverMock.mockReset().mockResolvedValue('plat-msg-id');
  });

  it('a send no bot can make moves the card and the row to the next approver', async () => {
    deliverMock.mockRejectedValueOnce(new Error('No telegram bot could deliver: Bad Request: chat not found'));
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-fallthrough'));
    await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(2));

    expect(deliverMock.mock.calls[0][1]).toBe('dm-owner');
    expect(deliverMock.mock.calls[1][0]).toBe('discord');
    expect(deliverMock.mock.calls[1][1]).toBe('dm-owner2');
    await vi.waitFor(async () => {
      const row = await getDb().get<{ approver_user_id: string }>(
        'SELECT approver_user_id FROM pending_channel_approvals',
      );
      expect(row?.approver_user_id).toBe('discord:owner2');
    });
    expect(undeliverable).toEqual([]);
  });

  it('when every send fails: no pending row and the host fallback is told', async () => {
    deliverMock.mockRejectedValue(new Error('No bot could deliver'));
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-nobody'));
    await vi.waitFor(() => expect(undeliverable).toHaveLength(1));

    expect(deliverMock).toHaveBeenCalledTimes(2);
    expect(undeliverable[0]).toMatchObject({
      channelType: 'telegram',
      reason: 'all_deliveries_failed',
      attempts: 2,
      title: '📣 Bot mentioned in new channel',
    });
    expect(await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(0);
  });

  it('when no approver has a reachable DM the host fallback is told', async () => {
    await getDb().run('DELETE FROM user_dms');
    const { routeInbound } = await import('../../router.js');
    await routeInbound(groupMention('chat-unreachable'));
    await vi.waitFor(() => expect(undeliverable).toHaveLength(1));

    expect(deliverMock).not.toHaveBeenCalled();
    expect(undeliverable[0]).toMatchObject({ reason: 'no_reachable_approver', attempts: 0 });
    expect(await countRows('SELECT COUNT(*) AS c FROM pending_channel_approvals')).toBe(0);
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

    expect(ag).toMatchObject({ folder: 'my-agent-2' });
    // Residue untouched.
    expect(fs.readFileSync(path.join(residue, 'memory.md'), 'utf8')).toBe('old group memory\n');
  });

  it('refuses, writing nothing, when the suffix takes the folder past 63 characters, saying the name is taken', async () => {
    const name = 'b'.repeat(62);
    fs.mkdirSync(path.join(TEST_DIR, 'groups', name), { recursive: true });

    expect(await createNewAgentGroup(name)).toBe(
      `Invalid group folder "${name}-2" — too long: 64 characters, at most 63 ("${name}" is already taken)`,
    );
    expect(await countRows('SELECT COUNT(*) AS c FROM agent_groups WHERE name = ?', name)).toBe(0);
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', `${name}-2`))).toBe(false);
  });

  // A v1 migration copies groups/global onto disk; the refusal must not depend on it.
  it.each([
    ['a fresh install', false],
    ['an install migrated from v1 (groups/global on disk)', true],
  ])('refuses "Global", writing nothing, on %s', async (_install, migrated) => {
    if (migrated) fs.mkdirSync(path.join(TEST_DIR, 'groups', 'global'), { recursive: true });

    expect(await createNewAgentGroup('Global')).toBe('Invalid group folder "global" — reserved');
    expect(await countRows("SELECT COUNT(*) AS c FROM agent_groups WHERE name = 'Global'")).toBe(0);
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', 'global-2'))).toBe(false);
  });
});

describe('describeResolvedRule', () => {
  it('shows a name-based pattern in a code span an agent name cannot leave', () => {
    expect(describeResolvedRule('namepattern', true, 'Scout\n# Trusted `x`', 'namepattern')).toBe(
      'will respond to messages matching `\\bScout\\u000a# Trusted \\u0060x\\u0060`',
    );
  });
});
