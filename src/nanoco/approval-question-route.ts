import { isGatewayApprovalQuestionId } from './approval-question-id.js';

export function routeQuestionMessage<T>(
  questionId: string,
  genericMessage: () => T,
  gatewayApprovalMessage: () => T,
): T {
  return isGatewayApprovalQuestionId(questionId) ? gatewayApprovalMessage() : genericMessage();
}
