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

/** Read container.json. Returns {} if absent or malformed (caller's
 *  defaults kick in via `??` chains). */
function readContainerJson(folder: string): LegacyContainerJson {
  const filePath = path.join(GROUPS_DIR, folder, 'container.json');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {};
    log.warn('Backfill: failed to read container.json, using defaults', { folder, err: String(err) });
    return {};
  }
  try {
    return JSON.parse(raw) as LegacyContainerJson;
  } catch (err) {
    log.warn('Backfill: failed to parse container.json, using defaults', { folder, err: String(err) });
    return {};
  }
}

/**
 * Post-backfill extension point (ADR 0006 contract #10). After core seeds
 * `container_configs` rows from disk, registered steps run once each to
 * augment those rows from sources core doesn't know about (e.g. an
 * install-overlay carrying forward legacy `.mcp.json` server entries).
 *
 * Inert by default: the registry is empty, so `runBackfillSteps()`
 * is a no-op and the upstream build/runtime is unchanged. Keep this file
 * dependency-light (config/db/log only) — registrants import it at module
 * load, so it must not import from src/index.ts or any module barrel.
 */
export type BackfillStep = () => void;

const backfillSteps: BackfillStep[] = [];

export function registerBackfillStep(step: BackfillStep): void {
  backfillSteps.push(step);
}

export function runBackfillSteps(): void {
  for (const step of backfillSteps) step();
}

export function backfillContainerConfigs(): void {
  const groups = getAllAgentGroups();
  let backfilled = 0;

  for (const group of groups) {
    // Skip if already has a config row
    if (getContainerConfig(group.id)) continue;

    const legacy = readContainerJson(group.folder);

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
      updated_at: new Date().toISOString(),
    };
    createContainerConfig(row);
    backfilled++;
  }

  if (backfilled > 0) log.info('Backfilled container_configs from disk', { count: backfilled });
}
