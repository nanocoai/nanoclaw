/**
 * "Reject with reason…" capture flow.
 *
 * Covers the three entry points end to end against the real central DB:
 *   - arming (handleApprovalsResponse with the third option) holds the row and
 *     prompts the admin instead of finalizing;
 *   - the captured reply relays one combined message, clamped to 280 chars;
 *   - the host sweep finalizes a ghosted hold as a plain reject.
 *
 * writeSessionMessage is mocked so the relayed agent-facing text can be read
 * back directly; the delivery adapter is a fake that records prompt sends.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  createSession,
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  markApprovalAwaitingReason,
} from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { REJECT_WITH_REASON_VALUE } from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-reject-reason' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-reject-reason';
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let delivered: Array<{ channelType: string; platformId: string; content: string }>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, content) {
    delivered.push({ channelType, platformId, content });
    return 'pm-1';
  },
};

function seedApproval(approvalId: string, action = 'create_agent'): void {
  createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action,
    payload: JSON.stringify({ name: 'child' }),
    created_at: now(),
    title: 'Approval',
    options_json: JSON.stringify([]),
  });
}

function dmReply(text?: string): InboundEvent {
  const content: Record<string, unknown> = { sender: 'admin-1', senderId: 'admin-1' };
  if (text !== undefined) content.text = text;
  return {
    channelType: DM_CHANNEL,
    platformId: DM_PLATFORM,
    threadId: null,
    message: { id: 'm-1', kind: 'chat', content: JSON.stringify(content), timestamp: now() },
  };
}

/** Click the "Reject with reason…" button as the seeded admin. */
async function clickRejectWithReason(approvalId: string): Promise<void> {
  const { handleApprovalsResponse } = await import('./response-handler.js');
  await handleApprovalsResponse({
    questionId: approvalId,
    value: REJECT_WITH_REASON_VALUE,
    userId: 'admin-1',
    channelType: DM_CHANNEL,
    platformId: '', // not surfaced by the click payload — resolved via ensureUserDm
    threadId: null,
  });
}

/** The text of the most recent agent-facing note written via writeSessionMessage. */
function lastRelayedText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  delivered = [];

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });

  // Authorized approver + a cached DM so ensureUserDm resolves without a
  // platform openDM call.
  upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reject with reason', () => {
  it('holds the row and prompts the admin instead of finalizing', async () => {
    seedApproval('appr-1');
    await clickRejectWithReason('appr-1');

    const row = getPendingApproval('appr-1');
    expect(row?.status).toBe('awaiting_reason');
    expect(row?.expires_at).toBeTruthy();

    // Prompt went to the admin's resolved DM, not the (empty) click platformId.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channelType).toBe(DM_CHANNEL);
    expect(delivered[0].platformId).toBe(DM_PLATFORM);
    expect((JSON.parse(delivered[0].content) as { text: string }).text).toMatch(/reason/i);

    // Agent is not notified yet — the hold is still open.
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it('relays the captured reason as one combined message and clears the row', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    seedApproval('appr-2', 'install_packages');
    await clickRejectWithReason('appr-2');

    const consumed = await captureReasonReply(dmReply('too risky for prod'));

    expect(consumed).toBe(true);
    expect(getPendingApproval('appr-2')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "too risky for prod"');
  });

  it('truncates an over-long reason to 280 chars with an ellipsis', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    seedApproval('appr-3');
    await clickRejectWithReason('appr-3');

    await captureReasonReply(dmReply('x'.repeat(400)));

    const reason = lastRelayedText()!.match(/: "(.*)"$/)![1];
    expect(reason).toHaveLength(280);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('finalizes a plain reject when the captured reply carries no text', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    seedApproval('appr-4');
    await clickRejectWithReason('appr-4');

    const consumed = await captureReasonReply(dmReply(undefined));

    expect(consumed).toBe(true);
    expect(getPendingApproval('appr-4')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your create_agent request was rejected by admin.');
  });

  it('does not swallow a later DM once the hold was already finalized', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    seedApproval('appr-5');
    await clickRejectWithReason('appr-5');
    // Simulate the sweep (or any other path) finalizing first.
    deletePendingApproval('appr-5');

    const consumed = await captureReasonReply(dmReply('late reason'));

    expect(consumed).toBe(false);
  });

  it('ignores DMs on channels with no armed reason capture', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    const consumed = await captureReasonReply({
      channelType: DM_CHANNEL,
      platformId: 'D-someone-else',
      threadId: null,
      message: { id: 'm', kind: 'chat', content: JSON.stringify({ text: 'hi' }), timestamp: now() },
    });
    expect(consumed).toBe(false);
  });
});

describe('reject-with-reason host sweep', () => {
  it('finalizes a hold whose window elapsed as a plain reject', async () => {
    const { sweepAwaitingReasonRejects } = await import('./reason-capture.js');
    seedApproval('appr-ghost', 'add_mcp_server');
    markApprovalAwaitingReason('appr-ghost', new Date(Date.now() - 1000).toISOString());

    await sweepAwaitingReasonRejects();

    expect(getPendingApproval('appr-ghost')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your add_mcp_server request was rejected by admin.');
  });

  it('leaves a still-open hold untouched', async () => {
    const { sweepAwaitingReasonRejects } = await import('./reason-capture.js');
    seedApproval('appr-open');
    markApprovalAwaitingReason('appr-open', new Date(Date.now() + 60_000).toISOString());

    await sweepAwaitingReasonRejects();

    expect(getPendingApproval('appr-open')?.status).toBe('awaiting_reason');
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });
});

describe('plain reject (regression)', () => {
  it('finalizes immediately with no reason and no DM prompt', async () => {
    const { handleApprovalsResponse } = await import('./response-handler.js');
    seedApproval('appr-plain', 'install_packages');

    await handleApprovalsResponse({
      questionId: 'appr-plain',
      value: 'reject',
      userId: 'admin-1',
      channelType: DM_CHANNEL,
      platformId: '',
      threadId: null,
    });

    expect(getPendingApproval('appr-plain')).toBeUndefined();
    expect(delivered).toHaveLength(0);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin.');
  });
});
