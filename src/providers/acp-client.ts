/**
 * Host-side container config for the `acp-client` provider.
 *
 * Resolves ACP client connection details per agent group and injects them
 * as env vars so the container-side AcpClientProvider can connect to the
 * right ACP-speaking agent.
 *
 * Per-group config (takes precedence):
 *   groups/<folder>/acp-client.json  —  one of:
 *     { "command": ["my-acp-agent", "--flag"] }     — subprocess mode
 *     { "host": "localhost", "port": 7777 }          — TCP mode
 *
 * Global fallback (.env or env vars):
 *   ACP_CLIENT_CMD   — JSON-serialised string array for subprocess mode
 *   ACP_CLIENT_HOST  — hostname for TCP mode
 *   ACP_CLIENT_PORT  — port for TCP mode
 */
import fs from 'fs';
import path from 'path';

import { getAgentGroup } from '../db/agent-groups.js';
import { GROUPS_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

interface AcpClientGroupConfig {
  command?: string[];
  host?: string;
  port?: number;
}

function readGroupConfig(agentGroupId: string): AcpClientGroupConfig {
  try {
    const ag = getAgentGroup(agentGroupId);
    if (!ag) return {};
    const configPath = path.join(GROUPS_DIR, ag.folder, 'acp-client.json');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    return {
      command: Array.isArray(raw.command) ? (raw.command as string[]) : undefined,
      host: typeof raw.host === 'string' ? raw.host : undefined,
      port: typeof raw.port === 'number' ? raw.port : undefined,
    };
  } catch {
    return {};
  }
}

registerProviderContainerConfig('acp-client', (ctx) => {
  const group = readGroupConfig(ctx.agentGroupId);
  const env: Record<string, string> = {};

  // Subprocess mode: command array → JSON-serialised env var
  const cmd = group.command;
  if (cmd?.length) {
    env.ACP_CLIENT_CMD = JSON.stringify(cmd);
  } else if (ctx.hostEnv.ACP_CLIENT_CMD) {
    env.ACP_CLIENT_CMD = ctx.hostEnv.ACP_CLIENT_CMD;
  }

  // TCP mode
  const host = group.host ?? ctx.hostEnv.ACP_CLIENT_HOST;
  const port = group.port ?? (ctx.hostEnv.ACP_CLIENT_PORT ? parseInt(ctx.hostEnv.ACP_CLIENT_PORT, 10) : undefined);
  if (host) env.ACP_CLIENT_HOST = host;
  if (port) env.ACP_CLIENT_PORT = String(port);

  // Bypass OneCLI proxy for local ACP servers
  if (host) {
    const existing = ctx.hostEnv.NO_PROXY || ctx.hostEnv.no_proxy || '';
    const noProxy = existing ? `${existing},${host}` : host;
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }

  return { env };
});
