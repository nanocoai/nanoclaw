/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the button-click response: look up the pending_questions
 * row, write the response into the session's inbound.db, wake the container.
 *
 * The `createPendingQuestion` call in `deliverMessage` (delivery.ts) stays
 * inline in core — it's 15 lines guarded by `hasTable('pending_questions')`,
 * modularizing it adds more registry surface than it saves.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { registerResponseHandler, type ResponseOutcome, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

/** Questions whose answer is being written: of two clicks, only the first answers. */
const answering = new Set<string>();

async function handleInteractiveResponse(payload: ResponsePayload): Promise<ResponseOutcome | false> {
  if (!(await hasTable(getDb(), 'pending_questions'))) return false;
  // Claimed before the row is read, and the row deleted only once the answer is
  // written: a click that read it earlier can't answer twice, and a write that
  // fails (the mailbox busy) leaves the question open to answer again.
  if (answering.has(payload.questionId)) return 'ignored';
  answering.add(payload.questionId);
  try {
    const pq = await getPendingQuestion(payload.questionId);
    if (!pq) return false;

    const session = await getSession(pq.session_id);
    if (!session) {
      log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
      await deletePendingQuestion(payload.questionId);
      return 'closed'; // ours, but the session that asked is gone
    }

    try {
      await writeSessionMessage(session.agent_group_id, session.id, {
        // One id per question: the mailbox refuses a second answer.
        id: `qr-${payload.questionId}`,
        kind: 'system',
        timestamp: new Date().toISOString(),
        platformId: pq.platform_id,
        channelType: pq.channel_type,
        threadId: pq.thread_id,
        content: JSON.stringify({
          type: 'question_response',
          questionId: payload.questionId,
          selectedOption: payload.value,
          userId: payload.userId ?? '',
        }),
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- logged; the card keeps its buttons for another try
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Answered already, but that click failed after the write (the row's
        // delete or the activity stamp): close the card, and wake the agent.
        await deletePendingQuestion(payload.questionId);
        // Not awaited: a slow container start must not hold the card open.
        void requestWake(session, 'interactive').catch((err: unknown) =>
          log.warn('Wake after a repeat question answer failed', { questionId: payload.questionId, err }),
        );
        return 'closed';
      }
      log.error('Question answer could not be written to the agent', { questionId: payload.questionId, err });
      return 'ignored';
    }
    // Written: the card can show the answer.
    payload.accepted?.();
    await deletePendingQuestion(payload.questionId);
    log.info('Question response routed', {
      questionId: payload.questionId,
      selectedOption: payload.value,
      sessionId: session.id,
    });

    await requestWake(session, 'interactive');
    return 'accepted';
  } finally {
    answering.delete(payload.questionId);
  }
}

registerResponseHandler(handleInteractiveResponse);
