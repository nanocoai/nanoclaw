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
import { deletePendingQuestion, getPendingQuestion, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'pending_questions')) return false;

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return false;

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
    deletePendingQuestion(payload.questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    kind: 'system',
    // trigger=0: consumed in place by the ask_user_question tool poll
    // (findQuestionResponse ignores trigger), never by a cold-woken container
    // (poll-loop filters kind='system'). Same pattern as the cli_response
    // write in delivery-action.ts. Without this, a click after the tool's
    // timeout leaves an orphaned trigger=1 row that re-wakes containers forever.
    trigger: 0,
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

  deletePendingQuestion(payload.questionId);
  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
  });

  await wakeContainer(session);
  return true;
}

registerResponseHandler(handleInteractiveResponse);
