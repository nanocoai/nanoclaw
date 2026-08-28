/**
 * Mirror host-originated outbound messages back into the agent's context.
 *
 * An agent's memory of a conversation is built from two things: messages the
 * user sent it (`messages_in`), and turns it composed itself. Messages the
 * *host* sends on the agent's behalf — approval prompts, reason prompts,
 * registration notices — are neither. They reach the user over the adapter
 * without ever passing through the agent, so the agent holds no record that
 * they were sent. A user replying to one ("why?", "yes, go ahead", "what is
 * this about?") lands on an agent with nothing to resolve the reference
 * against.
 *
 * Fix: after a host-originated delivery, write a mirror row into the target
 * session's `inbound.db` with `trigger: 0`, so it accumulates as context
 * without waking the agent. The next time the agent is genuinely triggered it
 * reads what was said on its behalf, and the user's reply has a referent.
 */
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { findSession } from './db/sessions.js';
import { writeSessionMessage } from './session-manager.js';
import { log } from './log.js';

/**
 * Record a message the host delivered to a user on the agent's behalf.
 *
 * Best-effort and non-throwing: context mirroring must never break or delay
 * the delivery it accompanies. Resolves the session from the delivery target,
 * so it is a no-op when the target has no session yet (nothing is listening
 * for a reply there anyway).
 *
 * Do NOT call this for messages the agent itself composed — those are already
 * in its own turn history, and mirroring them would duplicate context.
 */
export function recordAgentSent(
  channelType: string,
  platformId: string,
  text: string,
  instance?: string,
  threadId: string | null = null,
): void {
  if (!text) return;
  try {
    const mg = getMessagingGroupByPlatform(channelType, platformId, instance);
    if (!mg) return;
    const session = findSession(mg.id, threadId);
    if (!session) return;

    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'sent',
      timestamp: new Date().toISOString(),
      platformId,
      channelType,
      threadId,
      content: JSON.stringify({ text }),
      // Context only. A trigger-1 row here would make the agent respond to a
      // notification it did not send — the duplicate-message failure this is
      // meant to prevent, not cause.
      trigger: 0,
    });
  } catch (err) {
    log.warn('Failed to mirror host-sent message into agent context', { channelType, err });
  }
}
