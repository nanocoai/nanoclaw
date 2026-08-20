/**
 * Integration tests for the unknown-sender decline_notify flow.
 *
 * Covers:
 *  - decline_notify policy: unknown sender's message is dropped, the bot
 *    sends a polite decline into the origin DM, the owner gets a one-line
 *    FYI (plain text, not a card), and the drop is recorded
 *  - No approval card / pending card row — only the decline stamp
 *  - Dedupe: second message within 24h sends nothing further
 *  - An expired (>24h) stamp declines again
 *  - Policy flip back to request_approval: the stale stamp is cleared and
 *    the normal card flow works
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, getDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, updateMessagingGroup } from '../../db/messaging-groups.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter — record decline + FYI sends for assertions.
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-decline-notify' };
});

const TEST_DIR = '/tmp/nanoclaw-test-decline-notify';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  // Side-effect imports: register hooks (permissions module) AFTER the
  // mocks are in place.
  await import('./index.js');

  // Fixtures: agent group, a wired 1:1 DM messaging group with
  // decline_notify (a DM-shaped channel), owner + owner DM.
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });

  await createMessagingGroup({
    id: 'mg-dm-stranger',
    channel_type: 'telegram',
    platform_id: 'dm-stranger',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'decline_notify',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-dm-stranger',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  // Owner user (with display name — feeds the decline copy) + their DM.
  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Gavriel', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
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

function strangerDm(text: string) {
  return {
    channelType: 'telegram',
    platformId: 'dm-stranger',
    threadId: null,
    message: {
      id: `stranger-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        senderId: 'tg:stranger',
        // handleUnknownSender reads `sender` for the display name (same
        // extraction the request_approval card uses).
        sender: 'Stranger',
        text,
      }),
      timestamp: now(),
    },
  };
}

async function settle() {
  // The decline flow is fire-and-forget off the access gate.
  await new Promise((r) => setTimeout(r, 25));
}

async function waitForDeliveries(count: number): Promise<void> {
  await vi.waitFor(() => expect(deliverMock).toHaveBeenCalledTimes(count));
}

describe('unknown-sender decline_notify flow', () => {
  it('honors caller-supplied copy and conversation-scoped dedupe', async () => {
    const { declineAndNotify } = await import('./sender-approval.js');
    const event = strangerDm('hello');
    const input = {
      messagingGroupId: 'mg-dm-stranger',
      agentGroupId: 'ag-1',
      senderIdentity: 'telegram:stranger-1',
      senderName: 'Stranger One',
      event,
      dedupeKey: 'conversation',
      declineText: 'Only the owner can connect me here.',
      fyiText: 'FYI: I declined an unauthorized channel invitation.',
    };

    await declineAndNotify(input);
    await waitForDeliveries(2);
    expect(JSON.parse(deliverMock.mock.calls[0][4] as string).text).toBe(input.declineText);
    expect(JSON.parse(deliverMock.mock.calls[1][4] as string).text).toBe(input.fyiText);

    await declineAndNotify({
      ...input,
      senderIdentity: 'telegram:stranger-2',
      senderName: 'Stranger Two',
    });
    await settle();

    expect(deliverMock).toHaveBeenCalledTimes(2);
  });

  it('declines in the DM, FYIs the owner, records the drop — no card', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hi, can you book me a flight?'));
    await waitForDeliveries(2);

    // (a) Polite decline into the stranger's DM, as the bot.
    const [dChannel, dPlatform, dThread, dKind, dContent] = deliverMock.mock.calls[0];
    expect(dChannel).toBe('telegram');
    expect(dPlatform).toBe('dm-stranger');
    expect(dThread).toBeNull();
    expect(dKind).toBe('chat-sdk');
    const decline = JSON.parse(dContent as string);
    expect(decline.text).toBe("I'm Gavriel's personal agent — I can't help you directly.");
    expect(decline.options).toBeUndefined(); // plain text, no buttons

    // (b) One-line FYI to the owner's DM — informational, not a card.
    const [fChannel, fPlatform, , fKind, fContent] = deliverMock.mock.calls[1];
    expect(fChannel).toBe('telegram');
    expect(fPlatform).toBe('dm-owner');
    expect(fKind).toBe('chat-sdk');
    const fyi = JSON.parse(fContent as string);
    expect(fyi.type).toBeUndefined(); // not ask_question
    expect(fyi.options).toBeUndefined();
    expect(fyi.text).toContain('FYI');
    expect(fyi.text).toContain('Stranger (tg:stranger)');
    expect(fyi.text).toContain('ncl members add');

    // Drop recorded. (The gate writes reason 'unknown_sender_decline_notify';
    // core's structural no_agent_engaged record then upserts the same row —
    // pre-existing behavior shared with every refusal path.)
    const drop = await getDb().get<{ user_id: string }>(
      'SELECT user_id FROM unregistered_senders WHERE platform_id = ?',
      'dm-stranger',
    );
    expect(drop).toBeDefined();
    expect(drop!.user_id).toBe('tg:stranger');

    // No card rows anywhere — only the decline stamp.
    const rows = await getDb().all<{ id: string }>('SELECT id FROM pending_sender_approvals');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^decline:/);
    const channelRows = await getDb().get<{ c: number }>('SELECT COUNT(*) AS c FROM pending_channel_approvals');
    expect(channelRows).toBeDefined();
    expect(channelRows!.c).toBe(0);
  });

  it('dedupes: a second message within 24h sends no further decline or FYI', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    await routeInbound(strangerDm('are you there?'));
    await settle();

    // Still just the original decline + FYI pair; both drops recorded (each
    // message upserts twice: the gate's policy record + core's structural
    // no_agent_engaged record — pre-existing double-count on refusals).
    expect(deliverMock).toHaveBeenCalledTimes(2);
    const drop = await getDb().get<{ message_count: number }>(
      'SELECT message_count FROM unregistered_senders WHERE platform_id = ?',
      'dm-stranger',
    );
    expect(drop).toBeDefined();
    expect(drop!.message_count).toBe(4);
  });

  it('declines again once the 24h stamp expires', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    // Age the stamp past the window.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await getDb().run(`UPDATE pending_sender_approvals SET created_at = ? WHERE id LIKE 'decline:%'`, old);

    await routeInbound(strangerDm('hello again'));
    await waitForDeliveries(4);
    const stamp = await getDb().get<{ created_at: string }>(
      `SELECT created_at FROM pending_sender_approvals WHERE id LIKE 'decline:%'`,
    );
    expect(stamp).toBeDefined();
    expect(new Date(stamp!.created_at).getTime()).toBeGreaterThan(Date.now() - 60_000); // refreshed
  });

  it('flip request_approval→decline_notify with a card pending: card row converts to a stamp, dedupe holds', async () => {
    // Start on request_approval — the stranger's first message cards.
    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(1); // the approval card

    let rows = await getDb().all<{ id: string }>('SELECT id FROM pending_sender_approvals');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^nsa-/);

    // Operator flips the policy while the card is still pending.
    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'decline_notify' });
    deliverMock.mockClear();

    await routeInbound(strangerDm('are you there?'));
    await waitForDeliveries(2);

    // Decline + FYI went out; the pending card row became the stamp (the
    // UNIQUE(messaging_group_id, sender_identity) collision converts it).
    rows = await getDb().all<{ id: string }>('SELECT id FROM pending_sender_approvals');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^decline:/);

    // And the stamp dedupes: a third message sends nothing further.
    await routeInbound(strangerDm('hello??'));
    await settle();
    expect(deliverMock).toHaveBeenCalledTimes(2);
  });

  it('decline_notify on a group messaging group: silent drop — no public decline, no FYI', async () => {
    await createMessagingGroup({
      id: 'mg-team',
      channel_type: 'telegram',
      platform_id: 'group-team',
      name: 'Team',
      is_group: 1,
      unknown_sender_policy: 'decline_notify',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-team',
      messaging_group_id: 'mg-team',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const { routeInbound } = await import('../../router.js');
    await routeInbound({ ...strangerDm('hi all'), platformId: 'group-team' });
    await settle();

    // Nothing delivered anywhere — the DM-phrased decline must never be
    // posted publicly into the group channel; no stamp either.
    expect(deliverMock).not.toHaveBeenCalled();
    const drop = await getDb().get<{ user_id: string }>(
      'SELECT user_id FROM unregistered_senders WHERE platform_id = ?',
      'group-team',
    );
    expect(drop).toBeDefined();
    expect(drop!.user_id).toBe('tg:stranger');
    const stamps = await getDb().get<{ c: number }>('SELECT COUNT(*) AS c FROM pending_sender_approvals');
    expect(stamps).toBeDefined();
    expect(stamps!.c).toBe(0);
  });

  it('policy flip back to request_approval clears the stale stamp and cards normally', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(strangerDm('hello'));
    await waitForDeliveries(2);

    await updateMessagingGroup('mg-dm-stranger', { unknown_sender_policy: 'request_approval' });
    deliverMock.mockClear();

    await routeInbound(strangerDm('let me in'));
    await waitForDeliveries(1);

    // One card to the owner — the decline stamp did not block the UNIQUE key.
    const [, platform, , , content] = deliverMock.mock.calls[0];
    expect(platform).toBe('dm-owner');
    const payload = JSON.parse(content as string);
    expect(payload.type).toBe('ask_question');

    const rows = await getDb().all<{ id: string }>('SELECT id FROM pending_sender_approvals');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^nsa-/); // real card row; stamp gone
  });
});
