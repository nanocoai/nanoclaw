/**
 * Helper to restart all running containers for an agent group.
 *
 * Writes an on_wake message to each session, kills the container, then
 * wakes a fresh container via the onExit callback — race-free.
 */
import { isContainerRunning, killContainer } from './container-runner.js';
import { requestWake } from './request-wake.js';
import { isSplitGateway } from './modules/process-split/role.js';
import { setStopIntent, shadowWrite } from './db/coordination.js';
import { getSession, getSessionsByAgentGroup } from './db/sessions.js';
import { log } from './log.js';
import { withExistingMailboxSession, writeSessionMessage } from './session-manager.js';

/**
 * Kill all running containers for an agent group and respawn them.
 *
 * Only targets sessions that actually have a running container.
 * If `wakeMessage` is provided, each session gets an on_wake message
 * (picked up only by the fresh container's first poll) and a
 * wake request on exit. Without it, containers are killed and
 * only come back on the next real user message.
 */
export async function restartAgentGroupContainers(
  agentGroupId: string,
  reason: string,
  wakeMessage?: string,
): Promise<number> {
  // The split gateway cannot see containers (the runtime registry lives on
  // the controller plane): it targets every active session and lets the
  // controller's stop-intent honor pass skip the ones with nothing running.
  const sessions = (await getSessionsByAgentGroup(agentGroupId)).filter(
    (s) => s.status === 'active' && (isSplitGateway() || isContainerRunning(s.id)),
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
    const willRespawn = Boolean(wakeMessage || hasPending);
    // Shadow the respawn plan durably before the kill; the on_wake mechanism
    // stays authoritative. Cleared once the respawn request has been made.
    if (willRespawn) {
      await shadowWrite('stop-intent', () => setStopIntent(session.id, 'respawn_after_stop', new Date().toISOString()));
    }
    if (isSplitGateway()) {
      // No container access on this plane. The durable respawn_after_stop
      // intent written above is the kill+respawn order; the wake signal gets
      // the controller's consumer to honor it promptly. The intent clears on
      // the controller once the respawn wake succeeds.
      if (willRespawn) await requestWake(session, 'container-restart');
    } else {
      killContainer(
        session.id,
        reason,
        willRespawn
          ? () => {
              void (async () => {
                const s = await getSession(session.id);
                if (s) await requestWake(s, 'container-restart');
                await shadowWrite('stop-intent-clear', () => setStopIntent(session.id, null, new Date().toISOString()));
              })();
            }
          : undefined,
      );
    }
  }

  if (sessions.length > 0) {
    log.info('Restarting agent group containers', { agentGroupId, reason, count: sessions.length });
  }
  return sessions.length;
}
