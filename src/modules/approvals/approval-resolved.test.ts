/**
 * Approval-resolved callback registry.
 *
 * Drives the real response-handler entry (`handleApprovalsResponse`) and
 * asserts that callbacks registered via `registerApprovalResolvedHandler`
 * fire when an admin resolves a pending approval — the hook modules use to
 * observe approval resolution (e.g. clearing an "awaiting approval" status
 * indicator). Goes red if the response handler stops calling
 * `notifyApprovalResolved`.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval } from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { initSessionFolder } from '../../session-manager.js';
import { handleApprovalsResponse } from './response-handler.js';
import { registerApprovalHandler, registerApprovalResolvedHandler, type ApprovalResolvedEvent } from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-resolved' };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-resolved';

function now() {
  return new Date().toISOString();
}

function seedApproval(approvalId: string, action: string): void {
  createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action,
    payload: JSON.stringify({}),
    created_at: now(),
    title: 'Test approval',
    options_json: JSON.stringify([]),
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

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
  initSessionFolder('ag-1', 'sess-1');

  // Resolution only happens for authorized clicks — seed the clicking admin.
  upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('approval-resolved callbacks', () => {
  it('fires registered callbacks on reject with the approval, session, and outcome', async () => {
    const events: ApprovalResolvedEvent[] = [];
    registerApprovalResolvedHandler((event) => {
      events.push(event);
    });

    seedApproval('appr-reject-1', 'test_reject_action');
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-reject-1',
      value: 'reject',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('reject');
    expect(events[0].approval.approval_id).toBe('appr-reject-1');
    expect(events[0].approval.action).toBe('test_reject_action');
    expect(events[0].session.id).toBe('sess-1');
    expect(events[0].userId).toBe('slack:admin-1');
  });

  it('fires registered callbacks on approve after the action handler ran', async () => {
    const calls: string[] = [];
    registerApprovalHandler('test_approve_action', async () => {
      calls.push('handler');
    });
    registerApprovalResolvedHandler(({ outcome }) => {
      calls.push(`resolved:${outcome}`);
    });

    seedApproval('appr-approve-1', 'test_approve_action');
    await handleApprovalsResponse({
      questionId: 'appr-approve-1',
      value: 'approve',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(calls).toEqual(['handler', 'resolved:approve']);
  });

  it('isolates a throwing callback so later callbacks still fire', async () => {
    const events: string[] = [];
    registerApprovalResolvedHandler(() => {
      events.push('boom');
      throw new Error('callback exploded');
    });
    registerApprovalResolvedHandler(() => {
      events.push('after');
    });

    seedApproval('appr-reject-2', 'test_isolation_action');
    const claimed = await handleApprovalsResponse({
      questionId: 'appr-reject-2',
      value: 'reject',
      userId: 'slack:admin-1',
      channelType: 'slack',
      platformId: 'slack:C1',
      threadId: null,
    });

    expect(claimed).toBe(true);
    expect(events).toEqual(['boom', 'after']);
  });
});
