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
import { log } from './log.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

/**
 * Container-side path where a group's stamped plugins are mounted read-only.
 * Lockstep: create-agent.ts records `pluginRoot` under this prefix and
 * container-runner.ts mounts groups/<folder>/plugins here.
 */
export const CONTAINER_PLUGINS_DIR = '/workspace/agent/plugins';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Working directory in the Agent Plugins fixed forms (./p, ${PLUGIN_ROOT}[/p],
   * ${PLUGIN_DATA}[/p]). For plugin servers the agent-runner (plugin-mcp.ts)
   * resolves it to an absolute container path; providers consume it natively
   * (codex) or via a launch shim (cwd-shim.ts). Without a pluginRoot there is
   * nothing to resolve against, so the host strips it before container.json
   * is materialized (sanitizeStoredMcpServers — the only layer that does;
   * the runtime passes provenance-less servers through untouched). No CLI flag
   * or self-mod tool param exposes it; raw payloads carrying one are rejected
   * at intake (validateAddMcpServer), on original submission and approval
   * replay alike, and sanitizeStoredMcpServers strips it from stored entries
   * that lack plugin provenance.
   */
  cwd?: string;
  /**
   * Container-side plugin root (e.g. /workspace/agent/plugins/<name>), set at
   * stamp time for servers that arrived in a plugin. Internal — never part of
   * CLI input. The agent-runner expands ${PLUGIN_ROOT}/${PLUGIN_DATA} against
   * it and injects both env vars when building the provider's server map.
   */
  pluginRoot?: string;
  /**
   * Name of the plugin that stamped this server. Ownership marker: plugin-owned
   * servers reject CLI/self-mod edits and are swapped wholesale on restamp
   * (`ncl groups create --template`). Internal — never CLI input, and not
   * re-attached by sanitizeStoredMcpServers, so it never reaches container.json.
   */
  plugin?: string;
  instructions?: string;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /** See McpStdioServerConfig.plugin — same ownership marker. */
  plugin?: string;
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

/** The owning plugin's name when a stored MCP server entry was stamped from a plugin. */
export function mcpServerPluginOwner(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const plugin = (entry as Record<string, unknown>).plugin;
  return typeof plugin === 'string' && plugin !== '' ? plugin : undefined;
}

/** Throws unless `name` is a safe MCP server name (1-64 chars of [A-Za-z0-9_-]). */
export function validateMcpServerName(name: string): void {
  // "__proto__" passes the regex but assigning servers["__proto__"] sets the
  // record's prototype instead of an own key — the server would be silently
  // dropped (or worse) on every intake path, so reject it by name.
  if (!MCP_SERVER_NAME_RE.test(name) || name === '__proto__') {
    throw new Error('server name must be 1-64 characters of letters, digits, "_" or "-"');
  }
}

// The Agent Plugins fixed cwd shapes: ./p, ${PLUGIN_ROOT}[/p], ${PLUGIN_DATA}[/p].
const CWD_FORM_RE = /^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/;

/**
 * Parse one CLI or approval payload into the persisted MCP config shape.
 * Duplicated in container/agent-runner/src/mcp-tools/self-mod.ts
 * (parseMcpServerInput) — no shared modules across the host/container
 * boundary; keep the two in sync.
 */
export function parseMcpServerConfig(input: Record<string, unknown>): McpServerConfig {
  const command = typeof input.command === 'string' && input.command.trim() ? input.command : undefined;
  const url = typeof input.url === 'string' && input.url.trim() ? input.url.trim() : undefined;

  // A declared transport is honored; absence keeps the legacy CLI inference
  // (url → http, command → stdio). "streamable-http" is the Agent Plugins
  // spelling of the internal "http".
  const type = input.type === 'streamable-http' ? 'http' : input.type;
  if (type === 'sse') throw new Error('unsupported transport "sse"');
  if (type !== undefined && type !== 'stdio' && type !== 'http') {
    throw new Error('type must be "stdio", "http", or "streamable-http"');
  }
  if (type === 'stdio' && !command) throw new Error('type "stdio" requires command');
  if (type === 'http' && !url) throw new Error('type "http" requires url');

  const instructions = input.instructions;
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new Error('MCP instructions must be a string');
  }

  if (url !== undefined) {
    if (command !== undefined) throw new Error('Provide exactly one of command or url');
    if (input.args !== undefined || input.env !== undefined || input.cwd !== undefined) {
      throw new Error('args, env, and cwd are only valid with command');
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
    const headers = parseStringRecord(input.headers, 'headers');
    return {
      type: 'http',
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(instructions === undefined ? {} : { instructions }),
    };
  }
  if (command === undefined) throw new Error('Provide exactly one of command or url');

  if (input.headers !== undefined) throw new Error('headers is only valid with url');
  const args = input.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    throw new Error('args must be a JSON array of strings');
  }
  const env = parseStringRecord(input.env, 'env') ?? {};
  for (const key of Object.keys(env)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`env key ${JSON.stringify(key)} must be a valid environment variable name`);
    }
  }
  const cwd = parseCwd(input.cwd);
  return {
    command,
    args,
    env,
    ...(cwd === undefined ? {} : { cwd }),
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function parseStringRecord(value: unknown, flag: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${flag} must be a JSON object with string values`);
  }
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error(`${flag} must be a JSON object with string values`);
    record[key] = entry;
  }
  return record;
}

/** Accept only the spec's fixed cwd shapes, lexically contained (no ".." segments). */
function parseCwd(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CWD_FORM_RE.test(value)) {
    throw new Error('cwd must be ./path, ${PLUGIN_ROOT}[/path], or ${PLUGIN_DATA}[/path]');
  }
  // rest === '' is the bare form (`${PLUGIN_DATA}`, `./`); empty segments in a
  // non-empty rest are rejected for symmetry with the command validator.
  const rest = value.startsWith('./') ? value.slice(2) : value.replace(CWD_FORM_RE, '');
  if (
    rest.includes('${') ||
    rest.includes('\\') ||
    (rest !== '' && rest.split('/').some((s) => s === '..' || s === ''))
  ) {
    throw new Error('cwd escapes the plugin root');
  }
  return value;
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

/**
 * Defense-in-depth re-validation of the stored MCP server blob (threat: a
 * hand-edited DB value bypassing the three validated write paths). Invalid
 * entries are dropped + logged instead of shipped to the container.
 */
export function sanitizeStoredMcpServers(raw: unknown, groupName: string): Record<string, McpServerConfig> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log.warn('Stored mcp_servers is not an object; ignoring all entries', { group: groupName });
    return {};
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      log.warn('Dropping invalid stored MCP server', { group: groupName, server: name, reason: 'not an object' });
      continue;
    }
    try {
      validateMcpServerName(name);
      const server = parseMcpServerConfig(entry as Record<string, unknown>);
      const pluginRoot = (entry as Record<string, unknown>).pluginRoot;
      if (
        server.type !== 'http' &&
        typeof pluginRoot === 'string' &&
        pluginRoot.startsWith(`${CONTAINER_PLUGINS_DIR}/`)
      ) {
        server.pluginRoot = pluginRoot;
      }
      if (server.type !== 'http' && server.cwd && !server.pluginRoot) {
        // cwd resolves against a plugin root; without provenance nothing can
        // resolve it. This strip is the ONLY layer (the runtime passes
        // provenance-less servers through untouched), and the breadcrumb
        // lands in host logs instead of nowhere.
        delete server.cwd;
        log.warn('Stripping cwd from stored MCP server without plugin provenance', { group: groupName, server: name });
      }
      servers[name] = server;
      // eslint-disable-next-line no-catch-all/no-catch-all -- validation failures are data errors, not bugs
    } catch (err) {
      log.warn('Dropping invalid stored MCP server', {
        group: groupName,
        server: name,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return servers;
}

/** Build a `ContainerConfig` from a DB row + agent group identity. */
export function configFromDb(row: ContainerConfigRow, group: AgentGroup): ContainerConfig {
  return {
    mcpServers: sanitizeStoredMcpServers(JSON.parse(row.mcp_servers), group.name),
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
