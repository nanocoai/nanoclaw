import type { ContainerConfigRow } from '../types.js';
import { getDb } from './connection.js';

const SCALAR_COLUMNS = new Set([
  'provider',
  'model',
  'effort',
  'image_tag',
  'assistant_name',
  'max_messages_per_prompt',
  'cli_scope',
  'context_messages',
  'context_messages_max',
]);
const JSON_COLUMNS = new Set(['skills', 'mcp_servers', 'packages_apt', 'packages_npm', 'additional_mounts']);

export function getContainerConfig(agentGroupId: string): ContainerConfigRow | undefined {
  return getDb().prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(agentGroupId) as
    | ContainerConfigRow
    | undefined;
}

export function getAllContainerConfigs(): ContainerConfigRow[] {
  return getDb().prepare('SELECT * FROM container_configs').all() as ContainerConfigRow[];
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export function createContainerConfig(config: ContainerConfigRow): void {
  getDb()
    .prepare(
      `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, cli_scope, context_messages, context_messages_max, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @cli_scope, @context_messages, @context_messages_max, @updated_at
      )`,
    )
    .run(config);
}

/**
 * Default context-message settings for newly-created agent groups. Existing
 * rows on an upgrading install fall through the migration's column DEFAULT
 * (0/0) and are unaffected. New groups created post-migration get these
 * values so group chats work usefully out of the box.
 */
export const DEFAULT_NEW_GROUP_CONTEXT_MESSAGES = 10;
export const DEFAULT_NEW_GROUP_CONTEXT_MESSAGES_MAX = 20;

/** Create an empty config row with sensible defaults. Idempotent — no-ops if row exists. */
export function ensureContainerConfig(agentGroupId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO container_configs
         (agent_group_id, context_messages, context_messages_max, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      agentGroupId,
      DEFAULT_NEW_GROUP_CONTEXT_MESSAGES,
      DEFAULT_NEW_GROUP_CONTEXT_MESSAGES_MAX,
      new Date().toISOString(),
    );
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      | 'provider'
      | 'model'
      | 'effort'
      | 'image_tag'
      | 'assistant_name'
      | 'max_messages_per_prompt'
      | 'cli_scope'
      | 'context_messages'
      | 'context_messages_max'
    >
  >,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  getDb()
    .prepare(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`)
    .run(values);
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts. */
export function updateContainerConfigJson(
  agentGroupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts',
  value: unknown,
): void {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`)
    .run(JSON.stringify(value), now, agentGroupId);
}

export function deleteContainerConfig(agentGroupId: string): void {
  getDb().prepare('DELETE FROM container_configs WHERE agent_group_id = ?').run(agentGroupId);
}
