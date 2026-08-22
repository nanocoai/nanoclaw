/**
 * Creates a structured Away Mode decision request: validates the queue item
 * and its session, records the question on the queue item, and delivers a
 * real pending_approvals card via the same, unmodified approval-delivery
 * path every other approval already uses (pickApprover / pickApprovalDelivery
 * / requestApproval). Nothing about authorization changes here -- this is a
 * new `action` name flowing through the existing pipe, resolved by the same
 * isAuthorizedApprovalClick / hasAdminPrivilege checks as always.
 *
 * Claude has no agent session of its own, so this borrows Pepper's real,
 * live session purely for delivery routing (origin channel, notify-on-
 * failure target) -- it never replays or re-triggers anything on Pepper's
 * behalf. The approver is pinned explicitly to Kirk, not "any admin".
 *
 * Ported from old commit 0fb28c04, adapted from sync
 * `getDb().prepare(sql).get/run(...)` to the current async DbDriver
 * (`await getDb().get/run(sql, ...)`) -- no behavior change.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { requestApproval } from '../approvals/primitive.js';
import type { Session } from '../../types.js';
import {
  AWAY_MODE_DECISION_ACTION,
  AWAY_MODE_DECISION_CARD_TITLE,
  KIRK_APPROVER_USER_ID,
  PEPPER_AGENT_GROUP_ID,
} from './config.js';

export interface RequestAwayModeDecisionInput {
  queueItemId: string;
  /** Plain-language, decision-focused question text -- never raw technical output. */
  question: string;
}

export type RequestAwayModeDecisionResult = { ok: true; questionId: string } | { ok: false; reason: string };

interface KirkQuestion {
  question_id: string;
  asked_at: string;
  question_text: string;
  answered_at: string | null;
  answer_text: string | null;
}

async function findPepperSession(): Promise<Session | undefined> {
  return getDb().get<Session>(
    "SELECT * FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    PEPPER_AGENT_GROUP_ID,
  );
}

/**
 * Validates the queue item + its session, delivers the card, records the
 * question on the item, and only then reports success -- verified
 * independently (a fresh DB read, not trusting requestApproval's void
 * return) rather than assuming delivery worked.
 */
export async function requestAwayModeDecision(
  input: RequestAwayModeDecisionInput,
): Promise<RequestAwayModeDecisionResult> {
  const row = await getDb().get<{ session_id: string; kirk_questions: string }>(
    'SELECT session_id, kirk_questions FROM away_mode_queue WHERE id = ?',
    input.queueItemId,
  );
  if (!row) return { ok: false, reason: `away-mode-queue-item not found: ${input.queueItemId}` };

  const amSession = await getDb().get<{ status?: string }>(
    'SELECT status FROM away_mode_sessions WHERE id = ?',
    row.session_id,
  );
  if (!amSession || amSession.status !== 'ACTIVE') {
    return {
      ok: false,
      reason: `Cannot ask Kirk about ${input.queueItemId}: its Away Mode session (${row.session_id}) is not ACTIVE.`,
    };
  }

  const pepperSession = await findPepperSession();
  if (!pepperSession) {
    return { ok: false, reason: 'No active Pepper session found to route the decision card through.' };
  }

  const questionId = `amd-${randomUUID()}`;

  await requestApproval({
    session: pepperSession,
    agentName: 'Claude Code (Away Mode)',
    action: AWAY_MODE_DECISION_ACTION,
    payload: { queueItemId: input.queueItemId, questionId },
    title: AWAY_MODE_DECISION_CARD_TITLE,
    question: input.question,
    approverUserId: KIRK_APPROVER_USER_ID,
  });

  const created = await getDb().get(
    "SELECT 1 FROM pending_approvals WHERE action = ? AND payload LIKE ? AND status = 'pending'",
    AWAY_MODE_DECISION_ACTION,
    `%${questionId}%`,
  );
  if (!created) {
    return {
      ok: false,
      reason:
        'Card was not created -- requestApproval likely failed to find or reach an approver (check Pepper session for the notified reason).',
    };
  }

  const questions = JSON.parse(row.kirk_questions) as KirkQuestion[];
  questions.push({
    question_id: questionId,
    asked_at: new Date().toISOString(),
    question_text: input.question,
    answered_at: null,
    answer_text: null,
  });
  await getDb().run(
    'UPDATE away_mode_queue SET kirk_questions = ?, status = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(questions),
    'WAITING_FOR_KIRK',
    new Date().toISOString(),
    input.queueItemId,
  );

  return { ok: true, questionId };
}
