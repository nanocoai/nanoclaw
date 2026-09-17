/**
 * Validation + hold-request builder for agent-initiated bureaucracy
 * submissions. Mirrors src/modules/self-mod/request.ts's shape for a single,
 * non-rebuilding action: validation runs as the delivery wrapper's precheck,
 * and the hold builder creates the approval card when the guard holds. On
 * approve, the continuation re-enters the wrapped action and ./apply.ts runs.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';

export async function validateBureaucracySubmit(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    await notifyAgent(session, 'bureaucracy_submit failed: agent group not found.');
    return false;
  }
  const actionId = content.actionId as string;
  const summary = content.summary as string;
  if (!actionId || !summary) {
    await notifyAgent(session, 'bureaucracy_submit failed: actionId and summary are required.');
    log.warn('bureaucracy_submit: missing actionId or summary');
    return false;
  }
  return true;
}

export async function requestBureaucracySubmitHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;
  const actionId = content.actionId as string;
  const summary = content.summary as string;
  const site = (content.site as string) || 'unknown site';

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'bureaucracy_submit',
    payload: { actionId, site, summary },
    title: 'Bureaucracy Submission Request',
    question: `Agent "${agentGroup.name}" wants to submit something on ${site}:\n\n${summary}`,
  });
}
