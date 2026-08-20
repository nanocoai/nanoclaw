/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { withExistingMailboxSession, writeSessionMessage } from './session-manager.js';

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wakeContainer call on exit. Without it, containers are killed and
 * only come back on the next real user message.
 */
export async function restartAgentGroupContainers(
  agentGroupId: string,
  reason: string,
  wakeMessage?: string,
): Promise<number> {
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter(
    (s) => s.status === 'active' && isContainerRunning(s.id),
  );

  for (const session of sessions) {
    if (wakeMessage) {
      await writeSessionMessage(agentGroupId, session.id, {
        id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: agentGroupId,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({
          text: wakeMessage,
          sender: 'system',
          senderId: 'system',
        }),
        onWake: true,
      });
    }
    // Always respawn after the kill when there is anything to process: an
    // explicit wake message, or in-flight messages the dying container had
    // claimed. Without this, a provider switch mid-conversation leaves the
    // claimed messages dark until the next inbound or a slow sweep backoff.
    const hasPending =
      (await withExistingMailboxSession(
        session.agent_group_id,
        session.id,
        (mailbox) => mailbox.countDueMessages() > 0,
      )) ?? false;
    killContainer(
      session.id,
      reason,
      wakeMessage || hasPending
        ? () => {
            void (async () => {
              const s = await getSession(session.id);
              if (s) await wakeContainer(s);
            })();
          }
        : undefined,
    );
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
  }
  return sessions.length;
}
