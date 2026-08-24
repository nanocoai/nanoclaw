/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import type { Destination } from '../../mailbox/index.js';
import { log } from '../../log.js';
import { withMailboxSession } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

export async function writeDestinations(agentGroupId: string, sessionId: string): Promise<void> {
  const rows = await getDestinations(agentGroupId);
  const resolved: Destination[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = await getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        displayName: mg.name ?? row.local_name,
        type: 'channel',
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        agentGroupId: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = await getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        displayName: ag.name,
        type: 'agent',
        channelType: null,
        platformId: null,
        agentGroupId: ag.id,
      });
    }
  }

  await withMailboxSession(agentGroupId, sessionId, (db) => {
    db.replaceDestinations(resolved);
  });
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
