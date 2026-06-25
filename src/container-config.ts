/**
 * Container config types and materialization.
 *
 * Source of truth is the `container_configs` table in the central DB.
 * This module provides:
 *   - Type definitions for the file shape (read by the container runner)
 *   - `materializeContainerJson()` — writes `groups/<folder>/container.json`
 *     from the DB at spawn time
 *   - `configFromDb()` — builds a `ContainerConfig` from a DB row + agent group
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { readEnvFile } from './env.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>,
    packages: {
      apt: JSON.parse(row.packages_apt) as string[],
      npm: JSON.parse(row.packages_npm) as string[],
    },
    imageTag: row.image_tag ?? undefined,
    additionalMounts: JSON.parse(row.additional_mounts) as AdditionalMountConfig[],
    skills: JSON.parse(row.skills) as string[] | 'all',
    provider: row.provider ?? undefined,
    groupName: group.name,
    assistantName: row.assistant_name ?? group.name,
    agentGroupId: group.id,
    maxMessagesPerPrompt: row.max_messages_per_prompt ?? undefined,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
  };
}

/**
 * Expand `${VAR_NAME}` references in MCP server env values.
 * process.env takes precedence; envFile values are the fallback so secrets
 * stay in .env and never enter process.env (which would leak them to children).
 * Unresolved references are left as-is.
 */
function expandMcpEnvRefs(
  mcpServers: Record<string, McpServerConfig>,
  envFile: Record<string, string>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, cfg]) => [
      name,
      {
        ...cfg,
        env: cfg.env
          ? Object.fromEntries(
              Object.entries(cfg.env).map(([k, v]) => [
                k,
                v.replace(/\$\{([^}]+)\}/g, (_, varName) => process.env[varName] ?? envFile[varName] ?? v),
              ]),
            )
          : undefined,
      },
    ]),
  );
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 *
 * MCP server env values support `${VAR_NAME}` references — resolved from
 * process.env so secrets live in `.env`, not the DB.
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  // Collect ${VAR_NAME} refs across all MCP env blocks and resolve them from
  // .env — secrets stay out of process.env so they don't leak to children.
  const referencedVars = [
    ...new Set(
      Object.values(config.mcpServers)
        .flatMap(srv => Object.values(srv.env ?? {}))
        .flatMap(v => [...v.matchAll(/\$\{([^}]+)\}/g)].map(m => m[1])),
    ),
  ];
  const envFileVars = referencedVars.length > 0 ? readEnvFile(referencedVars) : {};

  const serialized = {
    ...config,
    mcpServers: expandMcpEnvRefs(config.mcpServers, envFileVars),
  };

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(serialized, null, 2) + '\n');

  return config;
}
