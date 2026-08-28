/**
 * Creates a structured Maintenance Coordinator decision request: a real
 * pending_approvals row, delivered as a card via the same, unmodified
 * approval-delivery path every other approval already uses. Same
 * authorization pipeline as always -- this is a new `action` name, not a
 * new mechanism.
 *
 * Maintenance Coordinator's own container never calls this directly (it
 * has no session of its own to reuse for delivery routing in the way
 * that matters here); the host-side apply handler in
 * ../maintenance-issue-report/apply.ts calls this after recording the
 * report. Routes through Pepper's live session purely for delivery
 * (same borrow-Pepper's-session pattern as away-mode-decisions), never
 * replaying anything on Pepper's behalf. Approver pinned explicitly to
 * Kirk.
 *
 * Ported from old commit 824318ff, adapted from sync
 * `getDb().prepare(sql).get(...)` to the current async DbDriver
 * (`await getDb().get(sql, ...)`) -- no behavior change.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { requestApproval } from '../approvals/primitive.js';
import type { Session } from '../../types.js';
import {
  KIRK_APPROVER_USER_ID,
  MAINTENANCE_DECISION_ACTION,
  MAINTENANCE_DECISION_CARD_TITLE,
  MAINTENANCE_DECISION_CARD_TITLE_URGENT,
  PEPPER_AGENT_GROUP_ID,
} from './config.js';

export interface RequestMaintenanceDecisionInput {
  issueId: string;
  /** Plain-language, decision-focused question text -- never raw technical output. */
  question: string;
  urgent: boolean;
}

export type RequestMaintenanceDecisionResult = { ok: true; questionId: string } | { ok: false; reason: string };

async function findPepperSession(): Promise<Session | undefined> {
  return getDb().get<Session>(
    "SELECT * FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    PEPPER_AGENT_GROUP_ID,
  );
}

export async function requestMaintenanceDecision(
  input: RequestMaintenanceDecisionInput,
): Promise<RequestMaintenanceDecisionResult> {
  const pepperSession = await findPepperSession();
  if (!pepperSession) {
    return { ok: false, reason: 'No active Pepper session found to route the decision card through.' };
  }

  const questionId = `md-${randomUUID()}`;

  await requestApproval({
    session: pepperSession,
    agentName: 'Maintenance Coordinator',
    action: MAINTENANCE_DECISION_ACTION,
    payload: { issueId: input.issueId, questionId },
    title: input.urgent ? MAINTENANCE_DECISION_CARD_TITLE_URGENT : MAINTENANCE_DECISION_CARD_TITLE,
    question: input.question,
    approverUserId: KIRK_APPROVER_USER_ID,
  });

  const created = await getDb().get(
    "SELECT 1 FROM pending_approvals WHERE action = ? AND payload LIKE ? AND status = 'pending'",
    MAINTENANCE_DECISION_ACTION,
    `%${questionId}%`,
  );
  if (!created) {
    return {
      ok: false,
      reason:
        'Card was not created -- requestApproval likely failed to find or reach an approver (check Pepper session for the notified reason).',
    };
  }

  return { ok: true, questionId };
}
