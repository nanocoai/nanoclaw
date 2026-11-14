/**
 * Regression coverage for approval response authorization.
 *
 * Approval cards may be delivered to an admin DM, but the callback payload is
 * still untrusted input. The response handler must not dispatch sensitive
 * approval handlers merely because a response carries a valid questionId.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-response-authz' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-response-authz';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createSession({
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
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('approval response authorization', () => {
  it('ignores a valid approval id clicked by a non-admin user', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages', handler);

    await createPendingApproval({
      approval_id: 'appr-1',
      session_id: 'sess-1',
      request_id: 'appr-1',
      action: 'install_packages',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const outcome = await handleApprovalsResponse({
      questionId: 'appr-1',
      value: 'approve',
      userId: 'stranger',
      channelType: 'telegram',
      platformId: 'dm-stranger',
      threadId: null,
    });

    // Refused: the card keeps its buttons for a real approver.
    expect(outcome).toBe('refused');
    expect(handler).not.toHaveBeenCalled();
    expect((await getPendingApproval('appr-1'))?.status).toBe('pending');
  });

  it('allows an owner/admin click to dispatch the registered approval handler', async () => {
    await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages_allowed', handler);

    await createPendingApproval({
      approval_id: 'appr-2',
      session_id: 'sess-1',
      request_id: 'appr-2',
      action: 'install_packages_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const outcome = await handleApprovalsResponse({
      questionId: 'appr-2',
      value: 'approve',
      userId: 'owner',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
    });

    expect(outcome).toBe('accepted');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'telegram:owner' }));
    expect(await getPendingApproval('appr-2')).toBeUndefined();
  });

  it('closes an approval whose session is gone, so its card can say it is no longer available', async () => {
    await upsertUser({ id: 'telegram:owner-gone', kind: 'telegram', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'telegram:owner-gone',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    const { handleApprovalsResponse } = await import('./response-handler.js');
    await createPendingApproval({
      approval_id: 'appr-gone',
      session_id: null,
      agent_group_id: 'ag-1',
      request_id: 'appr-gone',
      action: 'install_packages',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });
    const outcome = await handleApprovalsResponse({
      questionId: 'appr-gone',
      value: 'approve',
      userId: 'owner-gone',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
    });
    expect(outcome).toBe('closed');
    expect(await getPendingApproval('appr-gone')).toBeUndefined();
  });

  it('reports a plain Reject accepted once it is recorded, before the agent is woken', async () => {
    await upsertUser({ id: 'telegram:owner-reject', kind: 'telegram', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'telegram:owner-reject',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    const { wakeContainer } = await import('../../container-runner.js');
    // A slow wake (a cold container start).
    let wake!: () => void;
    vi.mocked(wakeContainer).mockImplementationOnce(
      () => new Promise((resolve) => (wake = () => resolve(true as never))),
    );
    const { handleApprovalsResponse } = await import('./response-handler.js');
    await createPendingApproval({
      approval_id: 'appr-reject-early',
      session_id: 'sess-1',
      request_id: 'appr-reject-early',
      action: 'install_packages',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });
    const accepted = vi.fn();
    void handleApprovalsResponse({
      questionId: 'appr-reject-early',
      value: 'reject',
      userId: 'owner-reject',
      channelType: 'telegram',
      platformId: 'dm-owner',
      threadId: null,
      accepted,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const early = accepted.mock.calls.length;
    await vi.waitFor(() => expect(wake).toBeTypeOf('function'));
    wake();
    expect(early).toBe(1);
  });

  it('lets only one concurrent approval response run the action handler', async () => {
    await upsertUser({ id: 'telegram:owner-race', kind: 'telegram', display_name: 'Owner', created_at: now() });
    await grantRole({
      user_id: 'telegram:owner-race',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn(async () => held);
    registerApprovalHandler('approval_race_action', handler);
    await createPendingApproval({
      approval_id: 'appr-race',
      session_id: 'sess-1',
      request_id: 'appr-race',
      action: 'approval_race_action',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Race approval',
      options_json: JSON.stringify([]),
    });
    const response = {
      questionId: 'appr-race',
      value: 'approve',
      userId: 'owner-race',
      channelType: 'telegram',
      platformId: 'dm-owner-race',
      threadId: null,
    };

    const accepted = vi.fn();
    const first = handleApprovalsResponse({ ...response, accepted });
    const second = handleApprovalsResponse({ ...response, accepted });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    // The winning click is reported before its action finishes.
    expect(accepted).toHaveBeenCalledTimes(1);
    release();

    // Only the winning click may resolve the card.
    expect((await Promise.all([first, second])).sort()).toEqual(['accepted', 'ignored']);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getPendingApproval('appr-race')).toBeUndefined();
  });

  it('allows global admins to resolve approvals without a session-scoped agent group', async () => {
    await upsertUser({
      id: 'telegram:global-admin',
      kind: 'telegram',
      display_name: 'Global Admin',
      created_at: now(),
    });
    await grantRole({
      user_id: 'telegram:global-admin',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('global_admin_allowed', handler);

    await createPendingApproval({
      approval_id: 'appr-3',
      session_id: 'sess-1',
      agent_group_id: null,
      request_id: 'appr-3',
      action: 'global_admin_allowed',
      payload: JSON.stringify({ packages: ['left-pad'] }),
      created_at: now(),
      title: 'Install packages',
      options_json: JSON.stringify([]),
    });

    const outcome = await handleApprovalsResponse({
      questionId: 'appr-3',
      value: 'approve',
      userId: 'global-admin',
      channelType: 'telegram',
      platformId: 'dm-global-admin',
      threadId: null,
    });

    expect(outcome).toBe('accepted');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getPendingApproval('appr-3')).toBeUndefined();
  });

  it('an approval with approver_user_id is resolvable by that user, not a non-assignee', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('assigned_approver_action', handler);

    await createPendingApproval({
      approval_id: 'appr-4',
      session_id: 'sess-1',
      request_id: 'appr-4',
      action: 'assigned_approver_action',
      payload: JSON.stringify({}),
      created_at: now(),
      title: 'Assigned approval',
      options_json: JSON.stringify([]),
      approver_user_id: 'telegram:dana',
    });

    // A non-assignee (no global/owner role) cannot resolve it.
    await handleApprovalsResponse({
      questionId: 'appr-4',
      value: 'approve',
      userId: 'stranger',
      channelType: 'telegram',
      platformId: 'dm-stranger',
      threadId: null,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(await getPendingApproval('appr-4')).toBeDefined();

    // The named approver resolves it.
    await handleApprovalsResponse({
      questionId: 'appr-4',
      value: 'approve',
      userId: 'dana',
      channelType: 'telegram',
      platformId: 'dm-dana',
      threadId: null,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await getPendingApproval('appr-4')).toBeUndefined();
  });
});
