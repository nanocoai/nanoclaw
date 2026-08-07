/**
 * requestApproval delivery-failure cleanup.
 *
 * requestApproval records the pending_approvals row before delivering the
 * card to the single picked approver. If that delivery throws, the row used
 * to linger forever as an approval nobody ever saw (and so nobody could
 * act on). These tests pin the fix: a failed delivery removes the
 * just-created row and notifies the requesting agent; a successful delivery
 * keeps it.
 *
 * Setup mirrors reason-capture.test.ts: real central DB, fake delivery
 * adapter, writeSessionMessage mocked to read back agent-facing text.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { requestApproval } from './primitive.js';

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

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
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
  createSession(session);

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
});

afterEach(() => {
  closeDb();
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
    expect(getPendingApprovalsByAction('test_action')).toHaveLength(0);
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

    expect(getPendingApprovalsByAction('test_action')).toHaveLength(1);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });
});
