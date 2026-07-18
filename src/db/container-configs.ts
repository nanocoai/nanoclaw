import { DEFAULT_AGENT_PROVIDER } from '../config.js';
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
        additional_mounts, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @updated_at
      )`,
    )
    .run(config);
}

/**
 * Create a config row if one doesn't exist, stamping the provider. Idempotent —
 * no-ops if the row already exists, so an existing group's provider is never
 * overwritten (load-bearing: this is how the global default stays "new groups
 * only" for groups that already have a row).
 *
 * An absent `provider` takes the instance default (`DEFAULT_AGENT_PROVIDER`);
 * `claude` and an absent value that resolves to claude are stored as NULL — the
 * column means "follows the built-in default", matching pre-feature rows.
 */
export function ensureContainerConfig(agentGroupId: string, provider?: string | null): void {
  // Single chokepoint for the instance default: a fresh row with no explicit
  // provider is stamped with DEFAULT_AGENT_PROVIDER, so every new-group creation
  // path inherits it without each having to remember. INSERT OR IGNORE keeps an
  // EXISTING row untouched — so this stays "new groups only" for any group that
  // already has a config row (backfillContainerConfigs seeds one for every group
  // at host startup; a non-claude default would only reach a row-less *legacy*
  // group if a creation script reused it before that first backfill ran). Callers
  // that know the provider (subagent → parent's, spawn → resolved) pass it
  // explicitly and override the default.
  // `claude` (the built-in default) and casing normalize to NULL/lowercase so the
  // column matches what resolution lowercases to.
  const normalized = (provider ?? DEFAULT_AGENT_PROVIDER).toLowerCase();
  const stamped = normalized && normalized !== 'claude' ? normalized : null;
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO container_configs (agent_group_id, provider, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(agentGroupId, stamped, new Date().toISOString());
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<
    Pick<
      ContainerConfigRow,
      'provider' | 'model' | 'effort' | 'image_tag' | 'assistant_name' | 'max_messages_per_prompt' | 'cli_scope'
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
