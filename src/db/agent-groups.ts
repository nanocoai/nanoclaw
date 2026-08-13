import type { AgentGroup } from '../types.js';
import { getDb } from './connection.js';
import { ensureContainerConfig } from './container-configs.js';

export function createAgentGroup(group: AgentGroup): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @created_at)`,
    )
    .run(group);
  ensureContainerConfig(group.id);
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
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}
