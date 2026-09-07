import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeOutboundDirect } from '../../session-manager.js';
import { notifyAgent } from '../approvals/index.js';

const SAFE_COMMAND_VALUE = /^[A-Za-z0-9._-]+$/;

export function buildAddAgentDestinationCommand(
  agentGroupId: string,
  localName: string,
  targetId: string,
): string | null {
  if (![agentGroupId, localName, targetId].every((value) => SAFE_COMMAND_VALUE.test(value))) return null;
  return `ncl destinations add --agent-group-id ${agentGroupId} --local-name ${localName} --target-type agent --target-id ${targetId}`;
}

/**
 * Tell the source what happened to its agent message: a system note to the
 * source agent, plus the same text queued to the session's attached chat when
 * it has one. Pass `agent: false` only where the approvals layer has already
 * written the agent's note. A true result means queued, not read by a human.
 */
export async function notifySource(
  sourceSessionId: string,
  text: string,
  opts: { agent?: boolean } = {},
): Promise<boolean> {
  try {
    const session = await getSession(sourceSessionId);
    if (!session) {
      log.warn('Could not notify source: session not found', { sourceSessionId });
      return false;
    }
    if (opts.agent !== false) await notifyAgent(session, text);

    const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    if (!origin) {
      log.info('Source session has no attached chat; agent-only notice', { sourceSessionId });
      return true;
    }
    await writeOutboundDirect(session.agent_group_id, session.id, {
      id: `a2a-human-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platformId: origin.platform_id,
      channelType: origin.channel_type,
      threadId: session.thread_id,
      content: JSON.stringify({ text }),
    });
    return true;
  } catch (err) {
    log.warn('Could not notify source', { sourceSessionId, err });
    return false;
  }
}
