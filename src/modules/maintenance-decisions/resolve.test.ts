/**
 * Maintenance Coordinator decision requests: creation (fixed card title,
 * pinned approver) and resolution (recorded back onto the exact
 * reported_issues row, regardless of approve / plain reject / reject-with-
 * reason). Mirrors away-mode-decisions/resolve.test.ts closely -- same
 * mechanism, different backing table.
 *
 * Ported from old commit 824318ff, adapted from the pre-async central DB
 * and sync createAgentGroup/createSession/createMessagingGroup/upsertUser/
 * grantRole/upsertUserDm to their current async equivalents -- no behavior
 * change.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { REJECT_WITH_REASON_VALUE } from '../approvals/primitive.js';
import { requestMaintenanceDecision } from './request.js';
import {
  KIRK_APPROVER_USER_ID,
  MAINTENANCE_DECISION_ACTION,
  MAINTENANCE_DECISION_CARD_TITLE,
  MAINTENANCE_DECISION_CARD_TITLE_URGENT,
  PEPPER_AGENT_GROUP_ID,
} from './config.js';
// Side-effect imports: registers the resolved-observer + approve notify
// handler, and (via maintenance-worker-actions) registerMigration() for
// the reported_issues table this module reads/writes.
import './resolve.js';
import '../maintenance-worker-actions/index.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-maintenance-decisions' };
});

const TEST_DIR = '/tmp/nanoclaw-test-maintenance-decisions';
const DM_CHANNEL = 'telegram';
const DM_PLATFORM = KIRK_APPROVER_USER_ID.split(':')[1];

let delivered: Array<{ channelType: string; platformId: string; content: string }>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, content) {
    delivered.push({ channelType, platformId, content });
    return 'pm-1';
  },
};

function now(): string {
  return new Date().toISOString();
}

async function seedIssue(id: string): Promise<void> {
  await getDb().run(
    `INSERT INTO reported_issues (id, worker_user_id, property_reference, description, urgency, reported_at, status)
     VALUES (?, 'telegram:900000001', 'SYNTHETIC Test Property', 'SYNTHETIC test issue', 'normal', ?, 'new')`,
    id,
    now(),
  );
}

async function getIssue(id: string): Promise<{ status: string; kirk_decision: string | null }> {
  return (await getDb().get<{ status: string; kirk_decision: string | null }>(
    'SELECT status, kirk_decision FROM reported_issues WHERE id = ?',
    id,
  ))!;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  delivered = [];

  await createAgentGroup({
    id: PEPPER_AGENT_GROUP_ID,
    name: 'Pepper',
    folder: 'pepper',
    agent_provider: null,
    created_at: now(),
  });
  await createSession({
    id: 'sess-pepper-1',
    agent_group_id: PEPPER_AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });

  await upsertUser({ id: KIRK_APPROVER_USER_ID, kind: 'telegram', display_name: 'Kirk', created_at: now() });
  await grantRole({
    user_id: KIRK_APPROVER_USER_ID,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-kirk-dm',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Kirk DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: KIRK_APPROVER_USER_ID,
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-kirk-dm',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('requestMaintenanceDecision', () => {
  it('creates a card with the fixed normal title, pinned to Kirk', async () => {
    await seedIssue('issue-1');
    const result = await requestMaintenanceDecision({
      issueId: 'issue-1',
      question: 'What should happen?',
      urgent: false,
    });

    expect(result.ok).toBe(true);
    expect(delivered).toHaveLength(1);
    const content = JSON.parse(delivered[0].content) as { title: string };
    expect(content.title).toBe(MAINTENANCE_DECISION_CARD_TITLE);

    const row = (await getDb().get<{ action: string; approver_user_id: string }>(
      'SELECT action, approver_user_id FROM pending_approvals',
    ))!;
    expect(row.action).toBe(MAINTENANCE_DECISION_ACTION);
    expect(row.approver_user_id).toBe(KIRK_APPROVER_USER_ID);
  });

  it('uses the fixed URGENT title when urgent=true', async () => {
    await seedIssue('issue-urgent');
    await requestMaintenanceDecision({ issueId: 'issue-urgent', question: 'Active leak reported.', urgent: true });

    const content = JSON.parse(delivered[0].content) as { title: string };
    expect(content.title).toBe(MAINTENANCE_DECISION_CARD_TITLE_URGENT);
  });
});

describe('resolution recording', () => {
  it('records approve as the decision', async () => {
    await seedIssue('issue-2');
    await requestMaintenanceDecision({ issueId: 'issue-2', question: 'Go ahead?', urgent: false });
    const approvalId = (await getDb().get<{ approval_id: string }>('SELECT approval_id FROM pending_approvals'))!
      .approval_id;

    await handleApprovalsResponse({
      questionId: approvalId,
      value: 'approve',
      userId: KIRK_APPROVER_USER_ID,
      channelType: DM_CHANNEL,
      platformId: DM_PLATFORM,
      threadId: null,
    });

    const issue = await getIssue('issue-2');
    expect(issue.kirk_decision).toBe('approve');
    expect(issue.status).toBe('kirk_decided');
  });

  it('records the free-text reason verbatim as the decision, not reframed as rejection', async () => {
    await seedIssue('issue-3');
    await requestMaintenanceDecision({ issueId: 'issue-3', question: 'What should happen?', urgent: false });
    const approvalId = (await getDb().get<{ approval_id: string }>('SELECT approval_id FROM pending_approvals'))!
      .approval_id;

    await handleApprovalsResponse({
      questionId: approvalId,
      value: REJECT_WITH_REASON_VALUE,
      userId: KIRK_APPROVER_USER_ID,
      channelType: DM_CHANNEL,
      platformId: '',
      threadId: null,
    });

    const { captureReasonReply } = await import('../approvals/reason-capture.js');
    await captureReasonReply({
      channelType: DM_CHANNEL,
      platformId: DM_PLATFORM,
      threadId: null,
      message: {
        id: 'm-1',
        kind: 'chat',
        content: JSON.stringify({ text: 'Send Elehazar today, before 3pm' }),
        timestamp: now(),
      },
    });

    const issue = await getIssue('issue-3');
    expect(issue.kirk_decision).toBe('Send Elehazar today, before 3pm');
  });

  it('ignores resolutions for unrelated approval actions', async () => {
    await seedIssue('issue-4');
    await getDb().run(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, title, options_json, approver_user_id)
       VALUES ('appr-other', 'sess-pepper-1', 'appr-other', 'install_packages', '{}', ?, 'Other', '[]', ?)`,
      now(),
      KIRK_APPROVER_USER_ID,
    );

    await handleApprovalsResponse({
      questionId: 'appr-other',
      value: 'reject',
      userId: KIRK_APPROVER_USER_ID,
      channelType: DM_CHANNEL,
      platformId: DM_PLATFORM,
      threadId: null,
    });

    const issue = await getIssue('issue-4');
    expect(issue.status).toBe('new');
    expect(issue.kirk_decision).toBeNull();
  });
});
