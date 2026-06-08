/**
 * Tests for the authorization gate in handleApprovalsResponse.
 *
 * The webhook receiver can't fully authenticate clicks (it only verifies
 * platform signatures), so the response handler must re-check that the
 * clicker is actually an eligible approver for the agent group before
 * dispatching the registered approval handler. Without this check, anyone
 * who can post a forged response to the webhook can attribute their
 * "approve" to any user id they choose.
 */
import fs from 'fs';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, createSession } from '../../db/sessions.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
  heartbeatPath: () => '/tmp/no-such-heartbeat',
}));

const TEST_DIR = '/tmp/nanoclaw-test-response-handler';
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

function now(): string {
  return new Date().toISOString();
}

const APPROVAL_OPTIONS = JSON.stringify([
  { label: 'Approve', value: 'approve' },
  { label: 'Reject', value: 'reject' },
]);

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  // Fixtures
  createAgentGroup({
    id: 'ag-1',
    name: 'TestAgent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createUser({ id: 'telegram:1111', kind: 'telegram', display_name: 'Owner', created_at: now() });
  createUser({ id: 'telegram:2222', kind: 'telegram', display_name: 'Stranger', created_at: now() });
  grantRole({
    user_id: 'telegram:1111',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    last_active: now(),
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    created_at: now(),
  });
  createPendingApproval({
    approval_id: 'appr-1',
    session_id: 'sess-1',
    request_id: 'appr-1',
    action: 'test_action',
    payload: JSON.stringify({ note: 'do the thing' }),
    created_at: now(),
    title: 'Test',
    options_json: APPROVAL_OPTIONS,
  });
});

afterEach(() => {
  closeDb();
});

describe('handleApprovalsResponse — clicker authorization', () => {
  it('authorized owner click invokes the registered handler and deletes the row', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const { getPendingApproval } = await import('../../db/sessions.js');

    let handlerCalled = false;
    let receivedUserId: string | undefined;
    registerApprovalHandler('test_action', async ({ userId }) => {
      handlerCalled = true;
      receivedUserId = userId;
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: '1111',
      channelType: 'telegram',
      platformId: 'telegram:1111',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(handlerCalled).toBe(true);
    // Handler receives the namespaced clicker id (channelType:rawUserId), not the raw platform id.
    expect(receivedUserId).toBe('telegram:1111');
    expect(getPendingApproval('appr-1')).toBeUndefined();
  });

  it('unauthorized clicker is rejected: handler is NOT invoked and the row stays intact', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const { getPendingApproval } = await import('../../db/sessions.js');

    let handlerCalled = false;
    registerApprovalHandler('test_action', async () => {
      handlerCalled = true;
    });

    const claimed = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: '2222', // Stranger — no role granted
      channelType: 'telegram',
      platformId: 'telegram:2222',
      threadId: null,
    });

    // Claimed so the dispatcher doesn't keep looping…
    expect(claimed).toBe(true);
    // …but the handler must not run.
    expect(handlerCalled).toBe(false);
    // Row is preserved so a real admin can still click later.
    expect(getPendingApproval('appr-1')).toBeDefined();
  });

  it('spoofed userId on a different channelType cannot impersonate the owner', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');

    let handlerCalled = false;
    registerApprovalHandler('test_action', async () => {
      handlerCalled = true;
    });

    // Same raw userId as the owner, but channelType is 'discord' — so
    // the namespaced id is "discord:1111", which is NOT in user_roles.
    await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: '1111',
      channelType: 'discord',
      platformId: 'discord:1111',
      threadId: null,
    });

    expect(handlerCalled).toBe(false);
  });

  it('missing userId is rejected', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');

    let handlerCalled = false;
    registerApprovalHandler('test_action', async () => {
      handlerCalled = true;
    });

    await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: null,
      channelType: 'telegram',
      platformId: 'telegram:1111',
      threadId: null,
    });

    expect(handlerCalled).toBe(false);
  });
});
