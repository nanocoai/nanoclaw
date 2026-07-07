/** Approve handler for a held a2a message. (Reject is handled by the generic response-handler path.) */
import { log } from '../../log.js';
import type { ApprovalHandler } from '../approvals/index.js';
import { performAgentRoute, type RoutableAgentMessage } from './agent-route.js';

export const applyA2aMessageGate: ApprovalHandler = async ({ session, payload, notify }) => {
  const { id, platform_id, content, in_reply_to } = payload;
  if (typeof platform_id !== 'string' || !platform_id) {
    notify('Message approved but the target agent group was missing from the request.');
    log.warn('a2a_message_gate apply: missing target', { sessionId: session.id });
    return;
  }

  const msg: RoutableAgentMessage = {
    id: typeof id === 'string' ? id : `a2a-gate-${Date.now()}`,
    platform_id,
    content: typeof content === 'string' ? content : '',
    in_reply_to: typeof in_reply_to === 'string' ? in_reply_to : null,
  };

  await performAgentRoute(msg, session, platform_id);
  log.info('Held agent message delivered after approval', {
    from: session.agent_group_id,
    to: platform_id,
    msgId: msg.id,
  });
};
