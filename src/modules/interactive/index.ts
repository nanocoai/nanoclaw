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

function pendingQuestionThreadMatchesPayload(
  pq: { platform_id: string | null; thread_id: string | null },
  payload: ResponsePayload,
): boolean {
  if ((pq.thread_id ?? null) === (payload.threadId ?? null)) return true;

  // Non-threaded/root-channel deliveries are persisted with a null thread_id,
  // but some Chat SDK adapters report button-click events with the root chat
  // id in event.threadId (for example Telegram DMs). Treat that root-thread
  // spelling as equivalent to null while keeping channel_type/platform_id strict.
  return pq.thread_id === null && payload.threadId === pq.platform_id;
}

function pendingQuestionMatchesPayload(
  pq: { channel_type: string | null; platform_id: string | null; thread_id: string | null },
  payload: ResponsePayload,
): boolean {
  return (
    pq.channel_type === payload.channelType &&
    pq.platform_id === payload.platformId &&
    pendingQuestionThreadMatchesPayload(pq, payload)
  );
}

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'pending_questions')) return false;

  const pq = getPendingQuestion(payload.questionId);
  if (!pq) return false;

  if (!pendingQuestionMatchesPayload(pq, payload)) {
    log.warn('Rejected question response from unexpected destination', {
      questionId: payload.questionId,
      expectedChannelType: pq.channel_type,
      expectedPlatformId: pq.platform_id,
      expectedThreadId: pq.thread_id,
      actualChannelType: payload.channelType,
      actualPlatformId: payload.platformId,
      actualThreadId: payload.threadId,
    });
    return true; // claimed: this is our questionId, but the response is not authorized
  }

  const session = getSession(pq.session_id);
  if (!session) {
    log.warn('Session not found for pending question', { questionId: payload.questionId, sessionId: pq.session_id });
    deletePendingQuestion(payload.questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
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
