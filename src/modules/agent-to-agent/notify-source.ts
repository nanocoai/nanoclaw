import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeOutboundDirect } from '../../session-manager.js';

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
 * Queue a notice in the source chat, or notify only the source agent when no
 * chat is attached. A true result means queued, not delivered to a human.
 */
export async function notifySource(sourceSessionId: string, text: string): Promise<boolean> {
  try {
    const session = await getSession(sourceSessionId);
    if (!session) {
      log.warn('Could not notify source: session not found', { sourceSessionId });
      return false;
    }

    const origin = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
    if (origin) {
      await writeOutboundDirect(session.agent_group_id, session.id, {
        id: `a2a-human-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        platformId: origin.platform_id,
        channelType: origin.channel_type,
        threadId: session.thread_id,
        content: JSON.stringify({ text }),
      });
      return true;
    }

    const { notifyAgent } = await import('../approvals/index.js');
    await notifyAgent(session, text);
    log.info('Agent-only notice queued: source session has no attached chat', { sourceSessionId });
    return true;
  } catch (err) {
    log.warn('Could not notify source', { sourceSessionId, err });
    return false;
  }
}
