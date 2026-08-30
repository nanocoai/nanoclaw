import { getDb, hasTable } from '../db/connection.js';
import { registerQuestionRenderResolver } from '../channels/question-render-registry.js';
import { approvalCardQuestion, persistedApprovalCardOptions } from './approval-card-render.js';
import { isGatewayApprovalQuestionId } from './approval-question-id.js';

interface PersistedApprovalQuestionRender {
  card_title: string;
  card_options_json: string;
  deadline: string;
  presentation_json: string;
}

/**
 * Restore the exact semantic presentation used for the live card before the
 * Chat SDK dispatches a compact 0/1 callback. Keeping this module-owned avoids
 * teaching NanoClaw core about Gateway tables or provider payloads.
 */
registerQuestionRenderResolver(async (questionId) => {
  if (!isGatewayApprovalQuestionId(questionId) || !(await hasTable(getDb(), 'nanoco_gateway_approvals'))) {
    return undefined;
  }
  const row = await getDb().get<PersistedApprovalQuestionRender>(
    `SELECT card_title, card_options_json, deadline, presentation_json
       FROM nanoco_gateway_approvals
      WHERE card_question_id = ? AND state = 'pending'`,
    questionId,
  );
  if (!row?.card_title) return undefined;
  return {
    title: row.card_title,
    question: approvalCardQuestion(row),
    options: persistedApprovalCardOptions(row.card_options_json),
  };
});
