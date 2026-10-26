/**
 * requestApproval delivery-failure cleanup, the card length limit, and which
 * thread the card joins.
 *
 * requestApproval records the pending_approvals row before delivering the
 * card to the single picked approver. If that delivery throws, the row used
 * to linger forever as an approval nobody ever saw (and so nobody could
 * act on). These tests pin the fix: a failed delivery removes the
 * just-created row and notifies the requesting agent; a successful delivery
 * keeps it. The card joins the requester's thread only when it lands in the
 * requester's own chat.
 *
 * Setup mirrors reason-capture.test.ts: real central DB, fake delivery
 * adapter, writeSessionMessage mocked to read back agent-facing text.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CardTooLongError, MAX_CARD_QUESTION_LENGTH } from '../../channels/ask-question.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  createPendingApproval,
  createSession,
  getPendingApproval,
  getPendingApprovalsByAction,
} from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { redeliverUnboundApprovals, requestApproval } from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-primitive' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-primitive';
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);

  // Authorized approver + a cached DM so ensureUserDm resolves without a
  // platform openDM call.
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The text of the most recent agent-facing note written via writeSessionMessage. */
function lastNotifyText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

describe('requestApproval delivery failure', () => {
  it('removes the pending approval row and notifies the agent when delivery throws', async () => {
    const failingAdapter: ChannelDeliveryAdapter = {
      async deliver() {
        throw new Error('platform down');
      },
    };
    setDeliveryAdapter(failingAdapter);

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: { key: 'value' },
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    // No orphan: the row created before the delivery attempt is gone.
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/test_action failed: could not deliver/);
  });

  it('keeps the pending approval row when delivery succeeds', async () => {
    const okAdapter: ChannelDeliveryAdapter = {
      async deliver() {
        return 'pm-1';
      },
    };
    setDeliveryAdapter(okAdapter);

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: { key: 'value' },
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(1);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });
});

describe('redeliverUnboundApprovals', () => {
  it('re-sends only the card a restart cut off, once', async () => {
    const sent: string[] = [];
    const adapter: ChannelDeliveryAdapter = {
      async deliver(_c, _p, _t, _k, content) {
        sent.push(JSON.parse(content).questionId);
        return `pm-${sent.length}`;
      },
    };
    setDeliveryAdapter(adapter);
    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'T',
      question: 'Q',
    });
    await createPendingApproval({
      approval_id: 'appr-lost',
      session_id: session.id,
      request_id: 'appr-lost',
      action: 'test_action',
      payload: '{}',
      created_at: now(),
      channel_type: DM_CHANNEL,
      platform_id: DM_PLATFORM,
      title: 'T',
      options_json: '[]',
    });

    await redeliverUnboundApprovals(adapter);
    await redeliverUnboundApprovals(adapter);

    expect(sent.slice(1)).toEqual(['appr-lost']);
    expect((await getPendingApproval('appr-lost'))?.platform_message_id).toBe('pm-2');
  });
});

describe('requestApproval card length', () => {
  it('refuses a question too long to show in full: no row, no card, the agent is told why', async () => {
    const deliver = vi.fn().mockResolvedValue('pm-1');
    setDeliveryAdapter({ deliver });

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'Test Approval',
      question: 'x'.repeat(MAX_CARD_QUESTION_LENGTH + 1),
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/test_action failed: the request is too long to show in full/);
  });

  it('tells the agent why when the channel refuses the card as too long', async () => {
    setDeliveryAdapter({
      async deliver() {
        throw new CardTooLongError('the request is too long to show in full on a card (1200 characters, limit 1000)');
      },
    });

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
    expect(lastNotifyText()).toBe(
      'test_action failed: the request is too long to show in full on a card (1200 characters, limit 1000). Shorten the request and try again.',
    );
  });

  it('cards a title plus question right at the limit', async () => {
    const deliver = vi.fn().mockResolvedValue('pm-1');
    setDeliveryAdapter({ deliver });

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'Test Approval',
      question: 'x'.repeat(MAX_CARD_QUESTION_LENGTH - 'Test Approval'.length),
    });

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(1);
  });
});

describe('requestApproval card thread', () => {
  /** Request an approval from a session in `messagingGroupId`/`threadId`; return the card's thread. */
  async function cardThreadFor(messagingGroupId: string | null, threadId: string | null): Promise<string | null> {
    const threads: Array<string | null> = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadIdArg) {
        threads.push(threadIdArg);
        return 'pm-1';
      },
    });
    const requester: Session = {
      ...session,
      id: 'sess-thread',
      messaging_group_id: messagingGroupId,
      thread_id: threadId,
    };
    await createSession(requester);

    await requestApproval({
      session: requester,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    expect(threads).toHaveLength(1);
    return threads[0];
  }

  it("posts in the requester's thread when the card lands in the requester's own chat", async () => {
    expect(await cardThreadFor('mg-dm-1', 'thread-1')).toBe('thread-1');
  });

  it("posts at the top level of the approver's DM when the request came from another chat", async () => {
    await createMessagingGroup({
      id: 'mg-origin',
      channel_type: DM_CHANNEL,
      platform_id: 'C-team',
      name: 'Team channel',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    expect(await cardThreadFor('mg-origin', 'thread-1')).toBeNull();
  });

  it('posts at the top level when the session has no thread', async () => {
    expect(await cardThreadFor('mg-dm-1', null)).toBeNull();
  });
});
