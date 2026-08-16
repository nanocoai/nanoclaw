/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import fs from 'fs';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { replaceDestinations, type DestinationRow } from '../../db/session-db.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

export function writeDestinations(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const rows = getDestinations(agentGroupId);
  const resolved: DestinationRow[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        display_name: mg.name ?? row.local_name,
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
        thread_id_override: row.thread_id_override ?? null,
      });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        display_name: ag.name,
        type: 'agent',
        channel_type: null,
        platform_id: null,
        agent_group_id: ag.id,
      });
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    replaceDestinations(db, resolved);
  } finally {
    db.close();
  }
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
