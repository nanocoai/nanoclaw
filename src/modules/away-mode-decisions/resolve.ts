/**
 * Records Kirk's resolution of an Away Mode decision card back onto the
 * exact away_mode_queue item + kirk_questions entry it was created for.
 *
 * Deliberately does NOT decide what the answer *means* for the queue item's
 * workflow status (WAITING_FOR_KIRK -> IN_PROGRESS/BLOCKED/etc.) -- that's
 * Claude's own next-wake business judgment, not something to bake into a
 * host callback. This only records what Kirk actually said, precisely.
 *
 * Explicitly treats "Reject with reason" as carrying Kirk's free-text
 * answer to an open-ended question, not as "the task was rejected" -- the
 * captured reason (if any) becomes the answer text as-is, never prefixed or
 * reframed as a negative outcome. A plain Reject (no reason typed) is the
 * one case recorded as a genuine "no".
 *
 * Ported from old commit 0fb28c04, adapted from sync
 * `getDb().prepare(sql).get/run(...)` to the current async DbDriver, and
 * `notify(...)` (now async, returns Promise<void>) is awaited. Depends on
 * ApprovalResolvedEvent.reason, landed standalone in 6425954b.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import {
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  type ApprovalResolvedEvent,
} from '../approvals/primitive.js';
import { AWAY_MODE_DECISION_ACTION } from './config.js';

interface KirkQuestion {
  question_id: string;
  asked_at: string;
  question_text: string;
  answered_at: string | null;
  answer_text: string | null;
}

function answerTextFor(event: ApprovalResolvedEvent): string {
  if (event.outcome === 'approve') return 'approve';
  if (event.reason && event.reason.trim()) return event.reason.trim();
  return 'reject';
}

async function recordResolution(event: ApprovalResolvedEvent): Promise<void> {
  const payload = JSON.parse(event.approval.payload) as { queueItemId?: string; questionId?: string };
  if (!payload.queueItemId || !payload.questionId) {
    log.error('away_mode_decision resolved with malformed payload', { approvalId: event.approval.approval_id });
    return;
  }

  const row = await getDb().get<{ kirk_questions: string }>(
    'SELECT kirk_questions FROM away_mode_queue WHERE id = ?',
    payload.queueItemId,
  );
  if (!row) {
    log.error('away_mode_decision resolved but its queue item no longer exists', { queueItemId: payload.queueItemId });
    return;
  }

  const questions = JSON.parse(row.kirk_questions) as KirkQuestion[];
  const idx = questions.findIndex((q) => q.question_id === payload.questionId);
  if (idx === -1) {
    log.error('away_mode_decision resolved but its question_id was not found on the queue item', {
      queueItemId: payload.queueItemId,
      questionId: payload.questionId,
    });
    return;
  }

  questions[idx] = { ...questions[idx], answered_at: new Date().toISOString(), answer_text: answerTextFor(event) };

  await getDb().run(
    'UPDATE away_mode_queue SET kirk_questions = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(questions),
    new Date().toISOString(),
    payload.queueItemId,
  );

  log.info('away_mode_decision resolved and recorded', {
    queueItemId: payload.queueItemId,
    questionId: payload.questionId,
    outcome: event.outcome,
    hadReason: Boolean(event.reason),
  });
}

registerApprovalResolvedHandler(async (event) => {
  if (event.approval.action !== AWAY_MODE_DECISION_ACTION) return;
  await recordResolution(event);
});

// Approve-path notify only -- the actual DB write happens in the resolved
// observer above (which fires for approve/reject/reject-with-reason alike).
// Without this, response-handler.ts's "no handler installed" fallback would
// leave a generic, slightly confusing note in Pepper's session instead.
registerApprovalHandler(AWAY_MODE_DECISION_ACTION, async ({ notify }) => {
  await notify('Kirk responded to the Away Mode decision card -- Claude will pick this up on its next check.');
});
