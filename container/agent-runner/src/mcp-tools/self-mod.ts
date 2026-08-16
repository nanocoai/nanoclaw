/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: {
          type: 'array',
          items: { type: 'string' },
          description: 'apt packages to install (names only, no version specs or flags)',
        },
        npm: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm packages to install globally (names only, no version specs)',
        },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt)
      return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

/**
 * Query keys that name a credential: camelCase-normalized, then matched as
 * whole words between [_.-] separators (`author` never matches `auth`, but
 * `authToken` does) — the URL persists to the container config and renders
 * on the approval card, so secrets must ride via OneCLI.
 */
const SECRET_QUERY_KEY_RE =
  /(^|[_.-])(o?auth(orization)?|(auth|access|api|session|id)?[_-]?token|secret|passw(or)?d|pwd|api[_-]?key|private[_-]?key|credentials?|bearer|jwt|sig(nature)?)([_.-]|$)/i;

/** camelCase → snake_case before matching, so `authToken` hits the word list. */
const CAMEL_SPLIT_RE = /([a-z0-9])([A-Z])/g;

type ParsedMcpServer = { type: 'http'; url: string } | { command: string; args: string[]; env: Record<string, string> };

/**
 * Names and env keys reach provider config writers with structural syntax —
 * e.g. mcpAllowPattern (providers/claude.ts) collapses non-[A-Za-z0-9_-] to
 * `_`, so unvalidated names could collide — hence a charset allowlist at
 * every entry point.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Mirrors the host's parseMcpServerConfig (src/container-config.ts) — the
 * host re-validates on receipt, but this copy answers the agent instantly.
 * No shared modules across the host/container boundary; keep the two in sync.
 * One deliberate gap: the host parses a cwd field, but no self-mod tool param
 * exposes it (plugin stamping and raw approval payloads are its only
 * carriers), so this copy has none.
 */
function parseMcpServerInput(args: Record<string, unknown>): { config: ParsedMcpServer } | { error: string } {
  const command = typeof args.command === 'string' && args.command.trim() ? args.command : undefined;
  const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;

  if (url !== undefined) {
    if (command !== undefined) return { error: 'Provide exactly one of command or url' };
    if (args.args !== undefined || args.env !== undefined) return { error: 'args and env are only valid with command' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: 'url must be a valid HTTP(S) URL' };
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      return { error: 'url must use HTTPS (plain HTTP is allowed only for localhost and host.docker.internal)' };
    }
    if (parsed.username || parsed.password || parsed.hash) {
      return { error: 'url must not contain credentials or fragments; use OneCLI for authentication' };
    }
    for (const key of parsed.searchParams.keys()) {
      if (SECRET_QUERY_KEY_RE.test(key.replace(CAMEL_SPLIT_RE, '$1_$2'))) {
        return { error: `url query parameter "${key}" looks like a credential; use OneCLI for authentication` };
      }
    }
    return { config: { type: 'http', url } };
  }
  if (command === undefined) return { error: 'Provide exactly one of command or url' };

  const commandArgs = args.args ?? [];
  if (!Array.isArray(commandArgs) || !commandArgs.every((arg) => typeof arg === 'string')) {
    return { error: 'args must be an array of strings' };
  }
  const rawEnv = args.env ?? {};
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    return { error: 'env must be an object with string values' };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== 'string') return { error: 'env must be an object with string values' };
    if (!ENV_KEY_RE.test(key)) {
      return { error: `env key ${JSON.stringify(key)} must be a valid environment variable name` };
    }
    env[key] = value;
  }
  return { config: { command, args: commandArgs, env } };
}

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config. Provide either the local `command` + optional `args`/`env`, or its remote Streamable HTTP `url` (HTTPS; plain HTTP only for localhost / host.docker.internal). Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        url: {
          type: 'string',
          description: 'Streamable HTTP MCP endpoint (HTTPS; plain HTTP only for localhost / host.docker.internal)',
        },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name'],
    },
  },
  async handler(args) {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!name) return err('name is required');
    if (!MCP_SERVER_NAME_RE.test(name)) {
      return err('server name must be 1-64 characters of letters, digits, "_" or "-"');
    }
    const parsed = parseMcpServerInput(args);
    if ('error' in parsed) return err(parsed.error);

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        ...parsed.config,
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${'url' in parsed.config ? 'HTTP' : parsed.config.command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer]);
