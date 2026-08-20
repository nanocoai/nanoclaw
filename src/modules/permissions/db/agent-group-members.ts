import type { AgentGroupMember } from '../../../types.js';
import { getDb } from '../../../db/connection.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from './user-roles.js';

export async function addMember(row: AgentGroupMember): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (@user_id, @agent_group_id, @added_by, @added_at)
       ON CONFLICT (user_id, agent_group_id) DO NOTHING`,
    row,
  );
}

export async function removeMember(userId: string, agentGroupId: string): Promise<void> {
  await getDb().run('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?', userId, agentGroupId);
}

export async function getMembers(agentGroupId: string): Promise<AgentGroupMember[]> {
  return getDb().all<AgentGroupMember>(
    'SELECT * FROM agent_group_members WHERE agent_group_id = ? ORDER BY added_at',
    agentGroupId,
  );
}

/**
 * Is the user "known" in this agent group?
 * Owner, global admin, and scoped admin are implicitly members.
 */
export async function isMember(userId: string, agentGroupId: string): Promise<boolean> {
  if ((await isOwner(userId)) || (await isGlobalAdmin(userId)) || (await isAdminOfAgentGroup(userId, agentGroupId))) {
    return true;
  }
  const row = await getDb().get(
    'SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1',
    userId,
    agentGroupId,
  );
  return !!row;
}

/** Direct row lookup — does not honor the admin/owner implicit-membership rule. */
export async function hasMembershipRow(userId: string, agentGroupId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 FROM agent_group_members WHERE user_id = ? AND agent_group_id = ? LIMIT 1',
    userId,
    agentGroupId,
  );
  return !!row;
}
