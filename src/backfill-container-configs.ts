/**
 * One-time backfill: seed `container_configs` rows from existing
 * `groups/<folder>/container.json` files and `agent_groups.agent_provider`.
 *
 * Runs after migrations, before channel adapters start. Idempotent — skips
 * groups that already have a config row.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { McpServerConfig, AdditionalMountConfig } from './container-config.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { getContainerConfig, createContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import type { ContainerConfigRow } from './types.js';

interface LegacyContainerJson {
  mcpServers?: Record<string, McpServerConfig>;
  packages?: { apt?: string[]; npm?: string[] };
  imageTag?: string;
  additionalMounts?: AdditionalMountConfig[];
  skills?: string[] | 'all';
  provider?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
}

export async function backfillContainerConfigs(): Promise<void> {
  const groups = await getAllAgentGroups();
  let backfilled = 0;

  for (const group of groups) {
    // Skip if already has a config row
    if (await getContainerConfig(group.id)) continue;

    const legacy = readLegacyContainerJson(group.folder);

    // DB agent_provider wins over file provider (matches old cascade)
    const provider = group.agent_provider || legacy.provider || null;

    const row: ContainerConfigRow = {
      agent_group_id: group.id,
      provider,
      model: null,
      effort: null,
      image_tag: legacy.imageTag ?? null,
      assistant_name: legacy.assistantName ?? null,
      max_messages_per_prompt: legacy.maxMessagesPerPrompt ?? null,
      skills: JSON.stringify(legacy.skills ?? 'all'),
      mcp_servers: JSON.stringify(legacy.mcpServers ?? {}),
      packages_apt: JSON.stringify(legacy.packages?.apt ?? []),
      packages_npm: JSON.stringify(legacy.packages?.npm ?? []),
      additional_mounts: JSON.stringify(legacy.additionalMounts ?? []),
      cli_scope: 'group',
      timezone: null,
      speed: null,
      updated_at: new Date().toISOString(),
    };

    await createContainerConfig(row);
    backfilled++;
  }

  if (backfilled > 0) {
    log.info('Backfilled container_configs from disk', { count: backfilled });
  }
}

/**
 * Read a legacy `container.json`. The group folder is a host-owned mount
 * source the container cannot swap; only the leaf name is container-controlled,
 * so a no-follow open of the leaf (O_NONBLOCK so a planted FIFO can't block)
 * refuses a symlink or special file on any volume. The leaf must be a regular
 * file; anything else is skipped with a warning.
 */
function readLegacyContainerJson(folder: string): LegacyContainerJson {
  const file = path.join(GROUPS_DIR, folder, 'container.json');
  const skipped = (code?: string): LegacyContainerJson => {
    log.warn(
      'Backfill: legacy container.json is not a regular file or is unreadable; its settings were NOT imported. ' +
        'Re-add them with the `ncl groups config` commands (update, add-mcp-server, add-package).',
      { folder, code },
    );
    return {};
  };
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return skipped((err as NodeJS.ErrnoException).code);
  }
  let raw: string;
  try {
    if (!fs.fstatSync(fd).isFile()) return skipped('ENOTREG');
    raw = fs.readFileSync(fd, 'utf8');
  } catch (err) {
    // A stat/read failure (e.g. EIO) degrades to defaults, never aborts startup.
    return skipped((err as NodeJS.ErrnoException).code);
  } finally {
    // A close-time error must not abort startup either — the result is already decided.
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  // The parse error quotes the input, so only a generic reason is logged.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn('Backfill: legacy container.json is not a JSON object; its settings were NOT imported, using defaults', {
      folder,
    });
    return {};
  }
  return parsed as LegacyContainerJson;
}
