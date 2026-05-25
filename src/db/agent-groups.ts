import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(group: AgentGroup): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @created_at)`,
    )
    .run(group);
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function updateAgentGroup(id: string, updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>>): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

/**
 * Deletes the agent group and all rows that reference it. The original FK
 * declarations were authored without ON DELETE CASCADE, so this function
 * walks every dependent table in one transaction. An agent group with a
 * dangling session/wiring/member/role row is unusable anyway — the container,
 * inbound/outbound DBs, and routing config are all gone.
 */
export function deleteAgentGroup(id: string): number {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM agent_group_members WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM user_roles WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?').run(id);
    db.prepare('UPDATE pending_approvals SET agent_group_id = NULL WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM unregistered_senders WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM pending_sender_approvals WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM pending_channel_approvals WHERE agent_group_id = ?').run(id);
    return db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id).changes as number;
  });
  return tx() as number;
}
