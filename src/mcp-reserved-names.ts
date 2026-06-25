/**
 * MCP server names reserved for built-ins, rejected at host-side write paths (self-mod
 * `add_mcp_server`, CLI `config add-mcp-server`) so a user/agent gets a fail-loud error instead
 * of a server that the runner silently drops at next boot.
 *
 * This MIRRORS container/agent-runner/src/mcp-server-config.ts RESERVED_MCP_SERVER_NAMES (the
 * authoritative boot-time filter). Host and container are separate builds and cannot share a
 * module — keep the two in sync if a built-in name is ever added.
 */
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['nanoclaw']);

export function isReservedMcpServerName(name: string): boolean {
  return RESERVED_MCP_SERVER_NAMES.has(name);
}
