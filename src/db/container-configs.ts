import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, DEFAULT_AGENT_PROVIDER } from '../config.js';
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
  'timezone',
]);
const JSON_COLUMNS = new Set(['skills', 'mcp_servers', 'packages_apt', 'packages_npm', 'additional_mounts']);

export async function getContainerConfig(agentGroupId: string): Promise<ContainerConfigRow | undefined> {
  return getDb().get<ContainerConfigRow>('SELECT * FROM container_configs WHERE agent_group_id = ?', agentGroupId);
}

export async function getAllContainerConfigs(): Promise<ContainerConfigRow[]> {
  return getDb().all<ContainerConfigRow>('SELECT * FROM container_configs');
}

/** Insert a new config row. Caller must supply all JSON fields (use defaults for empty). */
export async function createContainerConfig(config: ContainerConfigRow): Promise<void> {
  await getDb().run(
    `INSERT INTO container_configs (
        agent_group_id, provider, model, effort, image_tag, assistant_name,
        max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
        additional_mounts, cli_scope, timezone, updated_at
      ) VALUES (
        @agent_group_id, @provider, @model, @effort, @image_tag, @assistant_name,
        @max_messages_per_prompt, @skills, @mcp_servers, @packages_apt, @packages_npm,
        @additional_mounts, @cli_scope, @timezone, @updated_at
      )`,
    config,
  );
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
export async function ensureContainerConfig(agentGroupId: string, provider?: string | null): Promise<void> {
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
  await getDb().run(
    `INSERT INTO container_configs (agent_group_id, provider, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (agent_group_id) DO NOTHING`,
    agentGroupId,
    stamped,
    new Date().toISOString(),
  );
}

/**
 * Docker tag component grammar (`[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`). Applied to
 * the agent group id before it is spliced into an image reference — every id
 * generator in the tree produces `ag-<uuid>`-shaped ids, so this only ever fires
 * on a hand-edited or imported row, but `buildAgentGroupImage` interpolates the
 * resulting tag into a shell command string (`container-runner.ts`), so the
 * assumption is enforced rather than trusted.
 */
const DOCKER_TAG_COMPONENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/**
 * `image_tag` is consumed unchecked as the `docker run` image argument
 * (`buildContainerArgs` — `containerConfig.imageTag || CONTAINER_IMAGE`),
 * so whatever lands in this column picks the image every container in the group
 * runs. The one CLI verb that writes it is registered `access:'approval'`
 * (`cli/resources/groups.ts`), so an agent gets a hold and an admin approval
 * card rather than a silent write — this check is defense in depth at the write
 * seam, which is also what covers `groups create`, host-side callers, and any
 * future write path.
 *
 * Exactly two values are ever legitimate, and both are derived from this
 * install's own image names: the base image itself, and the per-group image
 * `buildAgentGroupImage` builds as `${CONTAINER_IMAGE_BASE}:${agentGroupId}`.
 * Anything else — a foreign registry, another install's slug, another group's
 * derived image — is rejected.
 *
 * The allowlist is built at call time instead of baked into a module-level
 * pattern because both names are env-overridable in `config.ts`; a hardcoded
 * `nanoclaw-agent-v2-…` regex would silently reject a legitimate
 * `CONTAINER_IMAGE_BASE` override.
 *
 * NULL and '' are allowed and mean "inherit the base image" — `imageTag ||
 * CONTAINER_IMAGE` treats them identically, and clearing the column is how a
 * derived image is retired.
 */
function assertAllowedImageTag(agentGroupId: string, value: unknown): void {
  if (value === null || value === '') return;
  // A group id that isn't a valid tag component gets no derived-image option at
  // all, rather than one we'd hand to `docker run` / `docker build` unexamined.
  const derived = DOCKER_TAG_COMPONENT.test(agentGroupId) ? `${CONTAINER_IMAGE_BASE}:${agentGroupId}` : null;
  if (value === CONTAINER_IMAGE || (derived !== null && value === derived)) return;

  const allowed = [`"${CONTAINER_IMAGE}" (base image)`];
  if (derived) allowed.push(`"${derived}" (this group's built image)`);
  throw new Error(
    `Invalid image_tag ${JSON.stringify(value)} for ${agentGroupId}: must be ` +
      `${allowed.join(' or ')}, or empty to inherit the base image.`,
  );
}

/** Update scalar fields on a config row. Only touches fields present in `updates`. */
export async function updateContainerConfigScalars(
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
      | 'timezone'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (!SCALAR_COLUMNS.has(key)) throw new Error(`Invalid scalar column: ${key}`);
      // Throws before the UPDATE is prepared, so a rejected image_tag aborts the
      // whole call rather than half-applying the other fields alongside it.
      if (key === 'image_tag') assertAllowedImageTag(agentGroupId, value);
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  await getDb().run(`UPDATE container_configs SET ${fields.join(', ')} WHERE agent_group_id = @agent_group_id`, values);
}

/** Overwrite a JSON column wholesale. Used for skills, mcp_servers, packages_*, additional_mounts. */
export async function updateContainerConfigJson(
  agentGroupId: string,
  column: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts',
  value: unknown,
): Promise<void> {
  if (!JSON_COLUMNS.has(column)) throw new Error(`Invalid JSON column: ${column}`);
  const now = new Date().toISOString();
  await getDb().run(
    `UPDATE container_configs SET ${column} = ?, updated_at = ? WHERE agent_group_id = ?`,
    JSON.stringify(value),
    now,
    agentGroupId,
  );
}

export async function deleteContainerConfig(agentGroupId: string): Promise<void> {
  await getDb().run('DELETE FROM container_configs WHERE agent_group_id = ?', agentGroupId);
}
