/**
 * mcp.json reading per the Agent Plugins 1.0.0 MCP component schema.
 *
 * Failure boundaries follow the spec: a missing file is fine; a malformed
 * file (bad JSON, wrong $schema, extra top-level fields) invalidates only the
 * MCP component; an invalid server entry skips only that server. The one
 * deliberate fatal case is a smuggled credential (threat #5): a value
 * matching a high-confidence secret pattern rejects the whole plugin so a
 * real key never lands in a registry install.
 */
import fs from 'fs';
import path from 'path';

import { parseMcpServerConfig, validateMcpServerName, type McpServerConfig } from '../container-config.js';
import { SECRET_ENV_KEY_RE, SECRET_VALUE_RE } from '../modules/self-mod/request.js';
import { MCP_SCHEMA_URL } from './manifest.js';

/** The one env/header value the stamp-time secret lint always accepts. */
export const PLACEHOLDER_VALUE = 'placeholder';

const STDIO_FIELDS = new Set(['type', 'command', 'args', 'env', 'cwd']);
const HTTP_FIELDS = new Set(['type', 'url', 'headers']);

// Hostnames that reach the Docker host from inside a container. Hygiene, not
// a boundary — the agent's own tools can reach the same endpoints; the real
// boundary is the container network policy.
const HOST_GATEWAY_HOSTS = new Set(['host.docker.internal', 'gateway.docker.internal', '172.17.0.1']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * plugin-data subpaths declared as a server `cwd` (`${PLUGIN_DATA}/sub`).
 * The stamp owns creating these: plugin-data is NanoClaw-managed writable
 * space, so a declared nested cwd must exist before the server first
 * launches or its `cd` fails and the server never boots. `./` and
 * `${PLUGIN_ROOT}` cwds point into the shipped plugin instead — if those
 * directories are missing, that is the plugin's bug.
 */
export function pluginDataCwdSubpaths(servers: Record<string, McpServerConfig>): string[] {
  const prefix = '${PLUGIN_DATA}/';
  return Object.values(servers).flatMap((s) =>
    s.type !== 'http' && s.cwd?.startsWith(prefix) ? [s.cwd.slice(prefix.length)] : [],
  );
}

export function readPluginMcp(pluginDir: string): { servers: Record<string, McpServerConfig>; report: string[] } {
  const report: string[] = [];
  const file = path.join(pluginDir, 'mcp.json');

  if (fs.existsSync(path.join(pluginDir, '.mcp.json'))) {
    report.push('.mcp.json: ignored (legacy name); rename it to mcp.json');
  }
  if (!fs.existsSync(file)) return { servers: {}, report };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    report.push('mcp.json: not valid JSON; MCP component skipped');
    return { servers: {}, report };
  }
  if (!isPlainObject(raw)) {
    report.push('mcp.json: not a JSON object; MCP component skipped');
    return { servers: {}, report };
  }
  if (raw.$schema !== MCP_SCHEMA_URL) {
    report.push(`mcp.json: $schema must be "${MCP_SCHEMA_URL}"; MCP component skipped`);
    return { servers: {}, report };
  }
  const unknownTop = Object.keys(raw).filter((key) => key !== '$schema' && key !== 'mcpServers');
  if (unknownTop.length > 0) {
    report.push(`mcp.json: allows exactly $schema and mcpServers (found "${unknownTop[0]}"); MCP component skipped`);
    return { servers: {}, report };
  }
  if (!isPlainObject(raw.mcpServers)) {
    report.push('mcp.json: mcpServers must be an object; MCP component skipped');
    return { servers: {}, report };
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    const skip = (reason: string): void => {
      report.push(`mcp.json: server "${name}" skipped: ${reason}`);
    };
    try {
      const server = readServerEntry(name, entry, report);
      if (typeof server === 'string') skip(server);
      else servers[name] = server;
    } catch (err) {
      // Secret rejection is fatal for the whole plugin — rethrow.
      throw err instanceof Error ? new Error(`mcp.json server "${name}": ${err.message}`, { cause: err }) : err;
    }
  }
  return { servers, report };
}

/**
 * Validate one server entry. Returns the parsed config, or a skip reason.
 * Throws only for smuggled secrets (whole-plugin rejection).
 */
function readServerEntry(name: string, entry: unknown, report: string[]): McpServerConfig | string {
  // Shared intake gate: names reach provider config writers with structural
  // syntax (codex TOML table headers), so the charset allowlist applies here
  // exactly as in the approval and ncl paths.
  try {
    validateMcpServerName(name);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!isPlainObject(entry)) return 'not an object';

  // The published mcp schema requires a declared transport on every entry.
  const type = entry.type;
  if (type === 'sse') return 'unsupported transport "sse"';
  if (type !== 'stdio' && type !== 'streamable-http') {
    return 'type must be "stdio" or "streamable-http"';
  }

  const allowed = type === 'stdio' ? STDIO_FIELDS : HTTP_FIELDS;
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key)) return `unknown field "${key}"`;
  }

  let server: McpServerConfig;
  try {
    server = parseMcpServerConfig({ ...entry, type: type === 'streamable-http' ? 'http' : type });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (server.type === 'http') {
    const hostname = new URL(server.url).hostname;
    if (HOST_GATEWAY_HOSTS.has(hostname)) return `URL host "${hostname}" reaches the container host; not allowed`;
    lintSecrets(name, 'header', server.headers ?? {}, report);
    return server;
  }

  // command is a single token: a bare executable name or a ./-relative path
  // resolved against PLUGIN_ROOT inside the container. No shell strings, no
  // placeholder expansion in the command itself.
  if (/\s/.test(server.command)) return 'command must be a single token (no shell strings)';
  if (server.command.includes('${')) return 'command does not support ${PLUGIN_ROOT}/${PLUGIN_DATA} expansion';
  if (server.command.startsWith('./')) {
    const segments = server.command.slice(2).split('/');
    if (segments.some((s) => s === '..' || s === '')) return 'command escapes the plugin root';
  } else if (server.command.includes('/') || server.command.includes('\\')) {
    return 'command must be a bare executable name or a ./-relative path';
  }

  for (const key of Object.keys(server.env ?? {})) {
    if (key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA') {
      return `env must not define "${key}" (the client always sets it)`;
    }
  }
  lintSecrets(name, 'env', server.env ?? {}, report);
  return server;
}

/**
 * Stamp-time secret lint (threat #5). High-confidence known-format matches
 * reject the whole plugin; a secret-looking KEY with an unrecognized value
 * only warns, so ordinary config values never block a legitimate setup.
 */
function lintSecrets(server: string, kind: 'env' | 'header', values: Record<string, string>, report: string[]): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === PLACEHOLDER_VALUE) continue;
    // SECRET_VALUE_RE is ^-anchored; strip an auth-scheme prefix so
    // "Bearer sk-…" (the common real-world header shape) still matches.
    const bare = value.replace(/^(Bearer|Token|Basic)\s+/i, '');
    if (SECRET_VALUE_RE.test(bare)) {
      throw new Error(
        `${kind} "${key}" looks like a real credential; ship the literal "${PLACEHOLDER_VALUE}" instead ` +
          '(operators supply real values after stamping)',
      );
    }
    if (SECRET_ENV_KEY_RE.test(key)) {
      report.push(
        `mcp.json: server "${server}" ${kind} "${key}" has a non-"${PLACEHOLDER_VALUE}" value; ` +
          'if it is a credential, use the placeholder convention',
      );
    }
  }
}
