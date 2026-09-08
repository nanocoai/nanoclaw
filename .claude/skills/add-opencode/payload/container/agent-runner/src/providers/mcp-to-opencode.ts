import { cwdWrappedArgv } from './cwd-shim.js';
import type { McpServerConfig } from './types.js';

/** OpenCode `mcp` entry shape (local stdio server). */
export type OpenCodeMcpLocal = {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
};

/** OpenCode `mcp` entry shape (remote HTTP server). */
export type OpenCodeMcpRemote = {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
  enabled: true;
};

export type OpenCodeMcpEntry = OpenCodeMcpLocal | OpenCodeMcpRemote;

/** Map NanoClaw MCP definitions into OpenCode's local/remote MCP config. */
export function mcpServersToOpenCodeConfig(
  servers: Record<string, McpServerConfig> | undefined,
): Record<string, OpenCodeMcpEntry> {
  const out: Record<string, OpenCodeMcpEntry> = {};
  if (!servers) return out;
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.type === 'http') {
      out[name] = {
        type: 'remote',
        url: cfg.url,
        ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
        enabled: true,
      };
      continue;
    }

    // OpenCode's local entry is a bare argv array with no spawn-directory
    // key, so a declared cwd goes through the shared cd-then-exec wrap —
    // never silently launched in the wrong directory.
    const args = cfg.args ?? [];
    const env = cfg.env ?? {};
    out[name] = {
      type: 'local',
      command: cfg.cwd ? cwdWrappedArgv(cfg.cwd, cfg.command, args) : [cfg.command, ...args],
      ...(Object.keys(env).length > 0 ? { environment: env } : {}),
      enabled: true,
    };
  }
  return out;
}
