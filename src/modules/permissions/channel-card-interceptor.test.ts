/**
 * Unit tests for the channel-card interceptor seam (B2/D24).
 *
 * Covers:
 *  - registerChannelCardInterceptor + consult order: the interceptor runs
 *    before any card work for its channel type only
 *  - 'handled' → no card delivered, no pending_channel_approvals row
 *  - 'card' → today's flow proceeds unchanged
 *  - interceptor throw → card fallback (a broken module never makes
 *    escalations vanish)
 *  - in-flight dedupe still short-circuits before the interceptor
 */
import fs from 'fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, getDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

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

// Mock ensureUserDm — look up the owner's preconfigured DM row.
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-card-interceptor' };
});

const TEST_DIR = '/tmp/nanoclaw-test-card-interceptor';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });

  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
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
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`,
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

async function unwiredChannel(id: string, channelType = 'telegram'): Promise<MessagingGroup> {
  const mg: MessagingGroup = {
    id,
    channel_type: channelType,
    platform_id: `chan-${id}`,
    instance: channelType,
    name: null,
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  };
  await createMessagingGroup(mg);
  return mg;
}

function mention(mg: MessagingGroup): InboundEvent {
  return {
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: now(),
      isMention: true,
      isGroup: true,
      content: JSON.stringify({ senderId: 'caller', senderName: 'Caller', text: '@bot hi' }),
    },
  };
}

async function pendingCount(): Promise<number> {
  return (await getDb().get<{ c: number }>('SELECT COUNT(*) AS c FROM pending_channel_approvals'))!.c;
}

describe('channel-card interceptor seam', () => {
  it("'handled' suppresses the card: no delivery, no pending row", async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    const interceptor = vi.fn().mockResolvedValue('handled');
    registerChannelCardInterceptor('telegram', interceptor);

    const mg = await unwiredChannel('mg-a');
    const event = mention(mg);
    await requestChannelApproval({ messagingGroupId: mg.id, event });

    expect(interceptor).toHaveBeenCalledTimes(1);
    expect(interceptor).toHaveBeenCalledWith(expect.objectContaining({ id: mg.id }), event);
    expect(deliverMock).not.toHaveBeenCalled();
    expect(await pendingCount()).toBe(0);
  });

  it("'card' proceeds with today's flow", async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    registerChannelCardInterceptor('telegram', vi.fn().mockResolvedValue('card'));

    const mg = await unwiredChannel('mg-b');
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(deliverMock.mock.calls[0][4] as string);
    expect(payload.type).toBe('ask_question');
    expect(await pendingCount()).toBe(1);
  });

  it('interceptor throw falls back to the card', async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    registerChannelCardInterceptor('telegram', vi.fn().mockRejectedValue(new Error('boom')));

    const mg = await unwiredChannel('mg-c');
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(deliverMock).toHaveBeenCalledTimes(1);
    expect(await pendingCount()).toBe(1);
  });

  it('only consulted for its own channel type', async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    const interceptor = vi.fn().mockResolvedValue('handled');
    registerChannelCardInterceptor('slack', interceptor);

    const mg = await unwiredChannel('mg-d'); // telegram
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(interceptor).not.toHaveBeenCalled();
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('in-flight dedupe short-circuits before the interceptor', async () => {
    const { registerChannelCardInterceptor, requestChannelApproval } = await import('./channel-approval.js');
    const interceptor = vi.fn().mockResolvedValue('card');
    registerChannelCardInterceptor('telegram', interceptor);

    const mg = await unwiredChannel('mg-e');
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });
    await requestChannelApproval({ messagingGroupId: mg.id, event: mention(mg) });

    expect(interceptor).toHaveBeenCalledTimes(1); // second call died at the pending-row check
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });
});
