/**
 * Away Mode decision requests: creation (fixed card title, pinned approver)
 * and resolution (recorded back onto the exact queue item + question,
 * regardless of approve / plain reject / reject-with-reason).
 *
 * Drives the real response-handler entry, same as the core approvals test
 * suite, so this exercises the actual authorization path
 * (isAuthorizedApprovalClick / hasAdminPrivilege) rather than a stand-in.
 *
 * Ported from old commit 0fb28c04, adapted from the pre-async central DB
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
import { requestAwayModeDecision } from './request.js';
import {
  AWAY_MODE_DECISION_ACTION,
  AWAY_MODE_DECISION_CARD_TITLE,
  KIRK_APPROVER_USER_ID,
  PEPPER_AGENT_GROUP_ID,
} from './config.js';
// Side-effect import: registers the migrations + the resolved-observer +
// approve notify handler (see ./index.js's header).
import './index.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-away-mode-decisions' };
});

const TEST_DIR = '/tmp/nanoclaw-test-away-mode-decisions';
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

async function seedQueueItem(id: string, sessionId = 'ams-1'): Promise<void> {
  await getDb().run(
    `INSERT INTO away_mode_sessions (id, started_at, status) VALUES (?, ?, 'ACTIVE')
     ON CONFLICT(id) DO NOTHING`,
    sessionId,
    now(),
  );
  await getDb().run(
    `INSERT INTO away_mode_queue (id, session_id, position, title, goal, created_at, updated_at)
     VALUES (?, ?, 1, 'Test item', 'Test goal', ?, ?)`,
    id,
    sessionId,
    now(),
    now(),
  );
}

async function getQueueItem(id: string): Promise<{ status: string; kirk_questions: string }> {
  return (await getDb().get<{ status: string; kirk_questions: string }>(
    'SELECT status, kirk_questions FROM away_mode_queue WHERE id = ?',
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

describe('requestAwayModeDecision', () => {
  it('creates a card with the fixed title, pinned to Kirk, carrying the queue/question linkage', async () => {
    await seedQueueItem('qi-1');
    const result = await requestAwayModeDecision({ queueItemId: 'qi-1', question: 'Should I proceed with X or Y?' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(delivered).toHaveLength(1);
    const content = JSON.parse(delivered[0].content) as { title: string; question: string; type: string };
    expect(content.title).toBe(AWAY_MODE_DECISION_CARD_TITLE);
    expect(content.question).toBe('Should I proceed with X or Y?');
    expect(content.type).toBe('ask_question');

    const row = (await getDb().get<{ action: string; approver_user_id: string; payload: string }>(
      'SELECT action, approver_user_id, payload FROM pending_approvals',
    ))!;
    expect(row.action).toBe(AWAY_MODE_DECISION_ACTION);
    expect(row.approver_user_id).toBe(KIRK_APPROVER_USER_ID);
    expect(JSON.parse(row.payload)).toEqual({ queueItemId: 'qi-1', questionId: result.questionId });
  });

  it('reports failure for an unknown queue item, without creating a card', async () => {
    const result = await requestAwayModeDecision({ queueItemId: 'qi-does-not-exist', question: 'x' });
    expect(result.ok).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  it('reports failure (not a silent success) when no Pepper session exists', async () => {
    await seedQueueItem('qi-no-pepper');
    await getDb().run('DELETE FROM sessions WHERE agent_group_id = ?', PEPPER_AGENT_GROUP_ID);

    const result = await requestAwayModeDecision({ queueItemId: 'qi-no-pepper', question: 'x' });
    expect(result.ok).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  it("reports failure when the item's Away Mode session is not ACTIVE", async () => {
    await getDb().run(
      "INSERT INTO away_mode_sessions (id, started_at, status) VALUES ('ams-stopped', ?, 'STOPPED')",
      now(),
    );
    await seedQueueItem('qi-stopped-session', 'ams-stopped');

    const result = await requestAwayModeDecision({ queueItemId: 'qi-stopped-session', question: 'x' });
    expect(result.ok).toBe(false);
    expect(delivered).toHaveLength(0);
  });
});

describe('resolution recording', () => {
  it('records approve as the answer, without touching item status', async () => {
    await seedQueueItem('qi-2');
    const req = await requestAwayModeDecision({ queueItemId: 'qi-2', question: 'Go ahead?' });
    if (!req.ok) throw new Error('unreachable');
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

    const item = await getQueueItem('qi-2');
    const questions = JSON.parse(item.kirk_questions);
    expect(questions[0].question_id).toBe(req.questionId);
    expect(questions[0].answer_text).toBe('approve');
    expect(questions[0].answered_at).toBeTruthy();
    // Business-logic status transition is Claude's job, not the observer's.
    expect(item.status).toBe('WAITING_FOR_KIRK');
  });

  it('records a plain reject (no reason typed) as "reject"', async () => {
    await seedQueueItem('qi-3');
    await requestAwayModeDecision({ queueItemId: 'qi-3', question: 'Go ahead?' });
    const approvalId = (await getDb().get<{ approval_id: string }>('SELECT approval_id FROM pending_approvals'))!
      .approval_id;

    await handleApprovalsResponse({
      questionId: approvalId,
      value: 'reject',
      userId: KIRK_APPROVER_USER_ID,
      channelType: DM_CHANNEL,
      platformId: DM_PLATFORM,
      threadId: null,
    });

    const questions = JSON.parse((await getQueueItem('qi-3')).kirk_questions);
    expect(questions[0].answer_text).toBe('reject');
  });

  it('records the free-text reason verbatim as the answer, NOT reframed as a rejection of the task', async () => {
    await seedQueueItem('qi-4');
    await requestAwayModeDecision({
      queueItemId: 'qi-4',
      question: 'Which vendor should the retry logic prefer, A or B?',
    });
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
        content: JSON.stringify({ text: 'Go with vendor B, A is deprecated' }),
        timestamp: now(),
      },
    });

    const questions = JSON.parse((await getQueueItem('qi-4')).kirk_questions);
    // The exact free text Kirk typed -- not "rejected: ..." or any negative reframing.
    expect(questions[0].answer_text).toBe('Go with vendor B, A is deprecated');
  });

  it('ignores resolutions for unrelated approval actions entirely', async () => {
    await seedQueueItem('qi-5');
    // A completely unrelated approval (different action, no away-mode payload).
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

    // The unrelated resolution must not have touched qi-5 at all.
    const item = await getQueueItem('qi-5');
    expect(JSON.parse(item.kirk_questions)).toEqual([]);
  });

  it(
    'records a late answer for audit/history when the session has since STOPPED, ' +
      'without reactivating the session or advancing the item -- resuming stays a separate, deliberate action',
    async () => {
      await seedQueueItem('qi-stale', 'ams-stale');
      const req = await requestAwayModeDecision({ queueItemId: 'qi-stale', question: 'Go ahead?' });
      if (!req.ok) throw new Error('unreachable');
      const approvalId = (await getDb().get<{ approval_id: string }>('SELECT approval_id FROM pending_approvals'))!
        .approval_id;

      // The session stops (Away Mode deactivated) before Kirk gets around to
      // answering the still-pending card -- the exact scenario observed in
      // production: a card answered days after its session already ended.
      await getDb().run("UPDATE away_mode_sessions SET status = 'STOPPED' WHERE id = 'ams-stale'");

      await handleApprovalsResponse({
        questionId: approvalId,
        value: 'approve',
        userId: KIRK_APPROVER_USER_ID,
        channelType: DM_CHANNEL,
        platformId: DM_PLATFORM,
        threadId: null,
      });

      // The answer is still recorded -- audit/history is preserved, never dropped.
      const item = await getQueueItem('qi-stale');
      const questions = JSON.parse(item.kirk_questions);
      expect(questions[0].answer_text).toBe('approve');
      expect(questions[0].answered_at).toBeTruthy();

      // Nothing about recording the answer advances the item's own workflow
      // status -- same as the ACTIVE-session case, this was always Claude's
      // job, never the observer's.
      expect(item.status).toBe('WAITING_FOR_KIRK');

      // Critically, recording the answer does NOT reactivate the session.
      // Resuming work requires a separate, deliberate away-mode-sessions
      // update back to ACTIVE (host-only, see away-mode-security.test.ts) --
      // a stale "approve" can never, by itself, silently resume work.
      const session = (await getDb().get<{ status: string }>(
        'SELECT status FROM away_mode_sessions WHERE id = ?',
        'ams-stale',
      ))!;
      expect(session.status).toBe('STOPPED');

      // And even if the session were reactivated, the queue item's own
      // preUpdate guard (away-mode-queue.ts) independently re-checks the
      // session is ACTIVE at the moment IN_PROGRESS is requested -- it does
      // not trust this old answered_at as a green light on its own.
    },
  );
});
