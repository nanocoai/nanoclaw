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

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroup } from './db/agent-groups.js';
import { isValidTimezone } from './timezone.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  instructions?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/**
 * Query keys that name a credential. Keys are camelCase-normalized, then
 * matched as whole words between [_.-] separators: `author` never matches
 * `auth`, but `authToken`, `clientSecret`, and `x-auth` all do. A match
 * hard-blocks registration — the URL persists to the container config and
 * renders on the approval card, so secrets must ride via OneCLI. Non-secret
 * query params are legitimate endpoint config (e.g. Datadog's `?toolsets=apm`).
 */
const SECRET_QUERY_KEY_RE =
  /(^|[_.-])(o?auth(orization)?|(auth|access|api|session|id)?[_-]?token|secret|passw(or)?d|pwd|api[_-]?key|private[_-]?key|credentials?|bearer|jwt|sig(nature)?)([_.-]|$)/i;

/** camelCase → snake_case before matching, so `authToken` hits the word list. */
const CAMEL_SPLIT_RE = /([a-z0-9])([A-Z])/g;

/**
 * Server names and env keys end up in provider config writers that emit
 * formats with structural syntax (codex writes TOML table headers), so an
 * unconstrained name is an injection vector even though the writers escape.
 * Allowlist the charset at every entry point (approval flow, ncl, templates)
 * so no downstream writer has to defend. Mirrored in
 * container/agent-runner/src/mcp-tools/self-mod.ts; keep the two in sync.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws unless `name` is a safe MCP server name (1-64 chars of [A-Za-z0-9_-]). */
export function validateMcpServerName(name: string): void {
  if (!MCP_SERVER_NAME_RE.test(name)) {
    throw new Error('server name must be 1-64 characters of letters, digits, "_" or "-"');
  }
}

/**
 * Parse one CLI or approval payload into the persisted MCP config shape.
 * Duplicated in container/agent-runner/src/mcp-tools/self-mod.ts
 * (parseMcpServerInput) — no shared modules across the host/container
 * boundary; keep the two in sync.
 */
export function parseMcpServerConfig(input: Record<string, unknown>): McpServerConfig {
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;

  const instructions = input.instructions;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('MCP instructions must be a string');
  }

  if (url !== undefined) {
    if (command !== undefined) throw new Error('Provide exactly one of command or url');
    if (input.args !== undefined || input.env !== undefined) {
      throw new Error('args and env are only valid with command');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new Error('url must be a valid HTTP(S) URL', { cause: err });
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      throw new Error('url must use HTTPS (plain HTTP is allowed only for localhost and host.docker.internal)');
    }
    if (parsed.username || parsed.password || parsed.hash) {
      throw new Error('url must not contain credentials or fragments; use OneCLI for authentication');
    }
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_QUERY_KEY_RE.test(key.replace(CAMEL_SPLIT_RE, '$1_$2'))) {
        throw new Error(`url query parameter "${key}" looks like a credential; use OneCLI for authentication`);
      }
    }
    return { type: 'http', url, ...(instructions === undefined ? {} : { instructions }) };
  }
  if (command === undefined) throw new Error('Provide exactly one of command or url');

  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('args must be a JSON array of strings');
  }
  const rawEnv = input.env ?? {};
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    throw new Error('env must be a JSON object with string values');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== 'string') throw new Error('env must be a JSON object with string values');
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`env key ${JSON.stringify(key)} must be a valid environment variable name`);
    }
    env[key] = value;
  }
  return {
    command,
    args,
    env,
    ...(instructions === undefined ? {} : { instructions }),
  };
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
  timezone?: string;
}

/**
 * Effective timezone for an agent group: per-group override → install global.
 * The ncl write path validates, but a hand-edited DB value must not silently
 * flip scheduling to UTC — an invalid override falls back to the global tz,
 * same as no override.
 */
export function resolveGroupTimezone(agentGroupId: string): string {
  const tz = getContainerConfig(agentGroupId)?.timezone;
  return tz && isValidTimezone(tz) ? tz : TIMEZONE;
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
    timezone: row.timezone && isValidTimezone(row.timezone) ? row.timezone : undefined,
  };
}

/**
 * Materialize `container.json` from the DB. Called at spawn time so the
 * container always sees fresh config. Returns the `ContainerConfig` for
 * use by the caller (buildMounts, buildContainerArgs, etc.).
 */
export function materializeContainerJson(agentGroupId: string): ContainerConfig {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);

  const row = getContainerConfig(agentGroupId);
  if (!row) throw new Error(`Container config not found for agent group: ${agentGroupId}`);

  const config = configFromDb(row, group);

  const p = path.join(GROUPS_DIR, group.folder, 'container.json');
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');

  return config;
}
