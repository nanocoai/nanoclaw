import type { MCPServerConfig } from '@github/copilot-sdk';

import type { McpServerConfig } from './types.js';

export function copilotMcpServers(servers: Record<string, McpServerConfig> = {}): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      server.type === 'http'
        ? { type: 'http' as const, url: server.url, headers: server.headers }
        : {
            type: 'stdio' as const,
            command: server.command,
            args: server.args,
            env: server.env,
            workingDirectory: server.cwd,
          },
    ]),
  );
}
