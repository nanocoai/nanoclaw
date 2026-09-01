export function isGatewayApprovalQuestionId(questionId: string): boolean {
  return /^nanoco-ask-[0-9a-f]{32}$/.test(questionId);
}
