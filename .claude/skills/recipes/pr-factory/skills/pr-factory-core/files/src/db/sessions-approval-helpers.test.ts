/**
 * pr-factory-core guard — the four pending_approvals helpers appended to
 * src/db/sessions.ts (getPendingApprovalsBySessionAction,
 * getPendingApprovalsBySession, updatePendingApprovalPlatformMessageId,
 * deletePendingApprovalsBySessionAction). pr-factory's approval-card flow
 * (dismiss-stale, card-id round-trip) consumes exactly these; deleting any
 * helper goes red here before it breaks the module at runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './index.js';
import {
  createPendingApproval,
  createSession,
  deletePendingApprovalsBySessionAction,
  getPendingApprovalsBySession,
  getPendingApprovalsBySessionAction,
  updatePendingApprovalPlatformMessageId,
  updatePendingApprovalStatus,
} from './sessions.js';

function now(): string {
  return new Date().toISOString();
}

function seed(approvalId: string, sessionId: string, action: string): void {
  createPendingApproval({
    approval_id: approvalId,
    session_id: sessionId,
    request_id: approvalId,
    action,
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'Test',
    options_json: '[]',
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  for (const id of ['sess-a', 'sess-b']) {
    createSession({
      id,
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'idle',
      last_active: null,
      created_at: now(),
    });
  }

  seed('appr-1', 'sess-a', 'pr_gh');
  seed('appr-2', 'sess-a', 'pr_send_to_testing');
  seed('appr-3', 'sess-b', 'pr_gh');
});

afterEach(() => {
  closeDb();
});

describe('pending_approvals helpers', () => {
  it('getPendingApprovalsBySessionAction filters by both session and action', () => {
    expect(getPendingApprovalsBySessionAction('sess-a', 'pr_gh').map((r) => r.approval_id)).toEqual(['appr-1']);
    expect(getPendingApprovalsBySessionAction('sess-a', 'pr_retry_test')).toEqual([]);
    expect(getPendingApprovalsBySessionAction('sess-b', 'pr_gh').map((r) => r.approval_id)).toEqual(['appr-3']);
  });

  it('getPendingApprovalsBySession returns only status=pending rows for the session', () => {
    const before = getPendingApprovalsBySession('sess-a');
    expect(before.map((r) => r.approval_id).sort()).toEqual(['appr-1', 'appr-2']);

    updatePendingApprovalStatus('appr-1', 'approved');
    expect(getPendingApprovalsBySession('sess-a').map((r) => r.approval_id)).toEqual(['appr-2']);
  });

  it('updatePendingApprovalPlatformMessageId round-trips through the row', () => {
    updatePendingApprovalPlatformMessageId('appr-2', '1700000000.000200');
    const [rowBack] = getPendingApprovalsBySessionAction('sess-a', 'pr_send_to_testing');
    expect(rowBack.platform_message_id).toBe('1700000000.000200');
  });

  it('deletePendingApprovalsBySessionAction deletes and reports the change count', () => {
    expect(deletePendingApprovalsBySessionAction('sess-a', 'pr_gh')).toBe(1);
    expect(deletePendingApprovalsBySessionAction('sess-a', 'pr_gh')).toBe(0);
    // Other sessions/actions untouched.
    expect(getPendingApprovalsBySessionAction('sess-b', 'pr_gh')).toHaveLength(1);
    expect(getPendingApprovalsBySessionAction('sess-a', 'pr_send_to_testing')).toHaveLength(1);
  });
});
