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
import { loadConfig } from '../config.js';
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
        apt: { type: 'array', items: { type: 'string' }, description: 'apt packages to install (names only, no version specs or flags)' },
        npm: { type: 'array', items: { type: 'string' }, description: 'npm packages to install globally (names only, no version specs)' },
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
    if (invalidApt) return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
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

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING third-party MCP server into YOUR per-agent runtime config — you must already know the exact `command` + `args` to invoke it (e.g. `npx @modelcontextprotocol/server-github`). Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        command: { type: 'string', description: 'Command to run the MCP server' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
        env: { type: 'object', description: 'Environment variables for the server' },
      },
      required: ['name', 'command'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    const command = args.command as string;
    if (!name || !command) return err('name and command are required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        command,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (${command})`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

export const changeModel: McpToolDefinition = {
  tool: {
    name: 'change_model',
    description:
      'Switch YOUR underlying AI model. Always call get_model first to see valid model IDs. Requires admin approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        model: {
          type: 'string',
          description: 'Full model identifier with provider prefix, e.g. "opencode-go/kimi-k2.6". Call get_model first to see the valid list.',
        },
        reason: { type: 'string', description: 'Why you want to switch models' },
      },
      required: ['model'],
    },
  },
  async handler(args) {
    const model = (args.model as string)?.trim();
    if (!model) return err('model is required');

    const provider = process.env.OPENCODE_PROVIDER || '';
    const apiKey = process.env.OPENCODE_API_KEY;

    // When running on opencode-go, validate against the live model list.
    if (provider === 'opencode-go' && apiKey) {
      if (!model.startsWith('opencode-go/')) {
        return err(`Model must start with "opencode-go/" for this provider. Call get_model to see valid options.`);
      }
      const modelId = model.replace('opencode-go/', '');
      try {
        const res = await fetch('https://opencode.ai/zen/go/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: { id: string }[] };
          const valid = (data.data ?? []).map((m) => m.id);
          if (!valid.includes(modelId)) {
            return err(
              `Unknown model "${modelId}". Valid opencode-go models:\n${valid.map((m) => `  opencode-go/${m}`).join('\n')}`,
            );
          }
        }
      } catch {
        // Network error — let it through and let the host validate
      }
    }

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'change_model',
        model,
        reason: (args.reason as string) || '',
      }),
    });

    log(`change_model: ${requestId} → "${model}"`);
    return ok(`Model change request submitted (→ ${model}). You will be notified when admin approves or rejects.`);
  },
};


export const getModel: McpToolDefinition = {
  tool: {
    name: 'get_model',
    description:
      'Returns the AI model you are currently running on, and fetches the list of models available on your current provider.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const config = loadConfig();
    const current = config.model || process.env.OPENCODE_MODEL || 'unknown';
    const provider = process.env.OPENCODE_PROVIDER || 'unknown';
    const apiKey = process.env.OPENCODE_API_KEY;

    let modelsText = '';
    if (apiKey && provider === 'opencode-go') {
      try {
        const res = await fetch('https://opencode.ai/zen/go/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: { id: string }[] };
          const ids = (data.data ?? []).map((m) => `- ${m.id}`).join('\n');
          modelsText = ids ? `\n\nAvailable models on opencode-go:\n${ids}` : '';
        }
      } catch {
        modelsText = '\n\n(Could not fetch model list — network error)';
      }
    }

    return ok(`Current model: ${current}\nProvider: ${provider}${modelsText}`);
  },
};

registerTools([installPackages, addMcpServer, changeModel, getModel]);
