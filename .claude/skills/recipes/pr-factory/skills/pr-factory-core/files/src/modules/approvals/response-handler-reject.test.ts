/**
 * pr-factory-core guard — the module's approval-resolved registration.
 *
 * pr-factory clears the 👀 awaiting-approval reaction (EMOJI_AWAITING,
 * Slack name 'warning') when an admin REJECTS an approval card. The reject
 * path resolves in core, so the module observes it via
 * registerApprovalResolvedHandler — a top-level registration in
 * src/modules/pr-factory/index.ts that runs even without env (inert mode).
 *
 * This drives the REAL handleApprovalsResponse with a reject payload after
 * importing the real pr-factory module, faking only global fetch. The
 * clicking user is seeded with an owner role — core's
 * isAuthorizedApprovalClick gate silently swallows clicks from
 * non-role-holders, which is itself the documented operator-setup
 * requirement. Deleting the module's registerApprovalResolvedHandler call
 * (or its reject filter calling clearAwaitingApproval) goes red. The core
 * half of the hook is guarded separately in approval-resolved.test.ts.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-prf-reject/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-prf-reject/groups',
  };
});

// Importing the module for its side effect: the approval-resolved registration.
import '../pr-factory/index.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, createSession } from '../../db/sessions.js';
import { createPrThread } from '../../db/pr-threads.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { initSessionFolder } from '../../session-manager.js';
import { handleApprovalsResponse } from './response-handler.js';

const TEST_DIR = '/tmp/nanoclaw-test-prf-reject';

function now(): string {
  return new Date().toISOString();
}

function seedSession(sessionId: string): void {
  createSession({
    id: sessionId,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder('ag-1', sessionId);
}

function seedApproval(approvalId: string, sessionId: string): void {
  createPendingApproval({
    approval_id: approvalId,
    session_id: sessionId,
    request_id: approvalId,
    action: 'pr_send_to_testing',
    payload: JSON.stringify({ filePath: '/tmp/none', fileName: 'none', prNumber: 42, repo: 'acme/widgets' }),
    created_at: now(),
    title: 'Send to Testing',
    options_json: '[]',
  });
}

async function reject(approvalId: string): Promise<boolean> {
  return handleApprovalsResponse({
    questionId: approvalId,
    value: 'reject',
    userId: 'slack:admin-1',
    channelType: 'slack',
    platformId: 'slack:C0WORK',
    threadId: null,
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: 'ag-1',
    name: 'Worker',
    folder: 'pr-factory-worker',
    agent_provider: null,
    created_at: now(),
  });
  // Authorize the clicking admin — without a user_roles row core's
  // isAuthorizedApprovalClick swallows the click and the hook never fires.
  upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  grantRole({ user_id: 'slack:admin-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('pr-factory reject-side reaction cleanup', () => {
  it('rejecting an approval on a PR-thread session removes the awaiting-approval reaction', async () => {
    seedSession('sess-pr');
    createPrThread({
      channel_id: 'slack:C0WORK',
      thread_ts: '1700000000.000100',
      channel_type: 'slack',
      repo_full_name: 'acme/widgets',
      pr_number: 42,
      session_id: 'sess-pr',
      created_at: now(),
    });
    seedApproval('appr-pr-1', 'sess-pr');

    expect(await reject('appr-pr-1')).toBe(true);

    const fetchMock = vi.mocked(globalThis.fetch);
    const removeCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('reactions.remove'));
    expect(removeCalls).toHaveLength(1);
    const body = JSON.parse(String(removeCalls[0][1]?.body)) as { channel: string; timestamp: string; name: string };
    expect(body).toMatchObject({ channel: 'C0WORK', timestamp: '1700000000.000100', name: 'warning' });
  });

  it('rejecting an approval on a session without a pr_threads row makes no Slack call', async () => {
    seedSession('sess-plain');
    seedApproval('appr-plain-1', 'sess-plain');

    expect(await reject('appr-plain-1')).toBe(true);

    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('reactions.remove'))).toHaveLength(0);
  });
});
