import { getDb, hasTable } from '../../db/connection.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerResource } from '../crud.js';

/**
 * Project the agent's central `agent_destinations` rows into every active
 * session's `inbound.db`. The agent-to-agent module is optional, so we guard
 * on `hasTable('agent_destinations')` and load `writeDestinations` lazily —
 * same pattern as container-runner.ts on container wake.
 *
 * Called from both `add` and `remove` so the live container picks up the
 * change without waiting for the next spawn. Without this, send_message to
 * the new local_name silently drops with "unknown destination" until restart.
 * See the destination-projection invariant in
 * src/modules/agent-to-agent/db/agent-destinations.ts.
 */
async function projectDestinationsToSessions(agentGroupId: string): Promise<void> {
  if (!hasTable(getDb(), 'agent_destinations')) return;
  const { writeDestinations } = await import('../../modules/agent-to-agent/write-destinations.js');
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    try {
      writeDestinations(agentGroupId, session.id);
    } catch (err) {
      log.warn('Failed to project destinations to session inbound.db', { agentGroupId, sessionId: session.id, err });
    }
  }
}

registerResource({
  name: 'destination',
  plural: 'destinations',
  table: 'agent_destinations',
  description:
    'Agent destination — per-agent routing entry and ACL. Each row authorizes an agent to send messages to a target (channel or another agent) and assigns a local name the agent uses to address it. Names are scoped to the source agent — two agents can have different local names for the same target. Created automatically when wiring channels or when agents create child agents.',
  idColumn: 'agent_group_id',
  scopeField: 'agent_group_id',
  columns: [
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent that owns this destination. References agent_groups.id.',
    },
    {
      name: 'local_name',
      type: 'string',
      description:
        'Name the agent uses to address this target (e.g. <message to="local_name">). Unique per agent. Lowercase, dash-separated.',
    },
    {
      name: 'target_type',
      type: 'string',
      description: '"channel" for messaging group targets, "agent" for agent-to-agent targets.',
      enum: ['channel', 'agent'],
    },
    {
      name: 'target_id',
      type: 'string',
      description: "The target's ID — messaging_groups.id for channels, agent_groups.id for agents.",
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open' },
  customOperations: {
    add: {
      access: 'approval',
      description: 'Add a destination for an agent. Use --agent-group-id, --local-name, --target-type, --target-id.',
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const localName = args.local_name as string;
        const targetType = args.target_type as string;
        const targetId = args.target_id as string;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!localName) throw new Error('--local-name is required');
        if (!targetType || !['channel', 'agent'].includes(targetType)) {
          throw new Error('--target-type must be channel or agent');
        }
        if (!targetId) throw new Error('--target-id is required');
        getDb()
          .prepare(
            `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
          )
          .run(agentGroupId, localName, targetType, targetId);
        await projectDestinationsToSessions(agentGroupId);
        return { agent_group_id: agentGroupId, local_name: localName, target_type: targetType, target_id: targetId };
      },
    },
    remove: {
      access: 'approval',
      description: 'Remove a destination from an agent. Use --agent-group-id and --local-name.',
      handler: async (args) => {
        const agentGroupId = args.agent_group_id as string;
        const localName = args.local_name as string;
        if (!agentGroupId) throw new Error('--agent-group-id is required');
        if (!localName) throw new Error('--local-name is required');
        const result = getDb()
          .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?')
          .run(agentGroupId, localName);
        if (result.changes === 0) throw new Error('destination not found');
        await projectDestinationsToSessions(agentGroupId);
        return { removed: { agent_group_id: agentGroupId, local_name: localName } };
      },
    },
  },
});
