import type { AgentGroup } from '../types.js';
import { getDb, hasTable } from './connection.js';

// Child tables referencing agent_groups(id) WITHOUT ON DELETE CASCADE. With
// foreign_keys=ON a bare DELETE of an agent group that has any dependent row
// fails ("FOREIGN KEY constraint failed"), so we clear dependents first inside
// a transaction. (container_configs cascades on its own.) Guarded by hasTable
// because some are optional-module tables.
const AGENT_GROUP_CHILD_TABLES = [
  'messaging_group_agents',
  'user_roles',
  'agent_group_members',
  'sessions',
  'pending_approvals',
  'agent_destinations',
  'pending_sender_approvals',
  'pending_channel_approvals',
];

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

export function deleteAgentGroup(id: string): void {
  const db = getDb();
  db.transaction(() => {
    for (const table of AGENT_GROUP_CHILD_TABLES) {
      if (hasTable(db, table)) {
        db.prepare(`DELETE FROM ${table} WHERE agent_group_id = ?`).run(id);
      }
    }
    db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
  })();
}
