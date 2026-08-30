/**
 * Response handler registry.
 *
 * Extracted from index.ts so that modules calling `registerResponseHandler()`
 * at import time don't hit a TDZ error on the const-array declaration.
 * index.ts imports src/modules/index.js for its side effects, which triggers
 * module registrations that would otherwise happen before index.ts's own
 * const initializers have run.
 *
 * Keep this file dependency-free (log.js is fine, but nothing from
 * modules/* or index.ts itself). Any file imported here must not in turn
 * import from src/index.ts, or the cycle returns.
 */

import { log } from './log.js';
import { isGatewayApprovalQuestionId } from './nanoco/approval-question-id.js';

export interface ResponsePayload {
  questionId: string;
  value: string;
  userId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type ResponseHandler = (payload: ResponsePayload) => Promise<boolean>;

const responseHandlers: ResponseHandler[] = [];

export function registerResponseHandler(handler: ResponseHandler): void {
  responseHandlers.push(handler);
}

export function getResponseHandlers(): readonly ResponseHandler[] {
  return responseHandlers;
}

export async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      logResponseDispatchError('Response handler threw', payload.questionId, err);
    }
  }
  if (isGatewayApprovalQuestionId(payload.questionId)) {
    log.warn('Unclaimed response', { code: 'approval_response_unclaimed' });
  } else {
    log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
  }
}

export function logResponseDispatchError(message: string, questionId: string, error: unknown): void {
  if (isGatewayApprovalQuestionId(questionId)) {
    log.error(message, { code: 'approval_handler_failed' });
  } else {
    log.error(message, { questionId, err: error });
  }
}
