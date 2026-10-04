/**
 * Bureaucracy-automation module — admin-approved agent-browser submissions.
 * Mirrors src/modules/self-mod/index.ts's registration shape; see that file
 * for the full rationale of guard-wrapped delivery actions.
 */
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { notifyAgent, registerApprovalHandler } from '../approvals/index.js';
import { applyBureaucracySubmit } from './apply.js';
import { bureaucracySubmit } from './guard.js';
import { requestBureaucracySubmitHold, validateBureaucracySubmit } from './request.js';

registerDeliveryAction('bureaucracy_submit', applyBureaucracySubmit, {
  guardAction: bureaucracySubmit,
  precheck: validateBureaucracySubmit,
  requestHold: requestBureaucracySubmitHold,
  onDeny: (_content, session, reason) => notifyAgent(session, `bureaucracy_submit denied: ${reason}`),
});

registerApprovalHandler('bureaucracy_submit', reenterGuardedDeliveryAction('bureaucracy_submit'));
