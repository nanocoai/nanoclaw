/** Per-message approval policies for agent-to-agent connections; no row = free flow. */
import type { AgentMessagePolicy } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

export function getMessagePolicy(fromAgentGroupId: string, toAgentGroupId: string): AgentMessagePolicy | undefined {
  return getDb()
    .prepare('SELECT * FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?')
    .get(fromAgentGroupId, toAgentGroupId) as AgentMessagePolicy | undefined;
}

export function setMessagePolicy(
  fromAgentGroupId: string,
  toAgentGroupId: string,
  approver: string,
  createdAt: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO agent_message_policies (from_agent_group_id, to_agent_group_id, approver, created_at)
       VALUES (@from_agent_group_id, @to_agent_group_id, @approver, @created_at)
       ON CONFLICT (from_agent_group_id, to_agent_group_id) DO UPDATE SET approver = excluded.approver`,
    )
    .run({ from_agent_group_id: fromAgentGroupId, to_agent_group_id: toAgentGroupId, approver, created_at: createdAt });
}

export function removeMessagePolicy(fromAgentGroupId: string, toAgentGroupId: string): boolean {
  const info = getDb()
    .prepare('DELETE FROM agent_message_policies WHERE from_agent_group_id = ? AND to_agent_group_id = ?')
    .run(fromAgentGroupId, toAgentGroupId);
  return info.changes > 0;
}

/** Delete every policy touching this agent group, so none outlives its connection. */
export function deletePoliciesTouching(agentGroupId: string): void {
  getDb()
    .prepare('DELETE FROM agent_message_policies WHERE from_agent_group_id = ? OR to_agent_group_id = ?')
    .run(agentGroupId, agentGroupId);
}
