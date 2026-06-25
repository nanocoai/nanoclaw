/**
 * Merge configured (container.json) MCP servers onto the trusted built-ins, RESERVING every
 * built-in name so a configured server can never override one.
 *
 * Without this, a last-write-wins merge let a container config define a server named e.g.
 * `nanoclaw` and shadow the trusted built-in. That is a privilege-escalation path in general,
 * and acute for a CONFINED turn (the provider exposes ONLY the `nanoclaw` server to an external
 * participant — if that name resolved to a config-supplied server, the confinement would hand the
 * external the attacker's server instead of the gated built-in). Built-in WINS on a name
 * collision; the colliding configured entry is dropped (reported via `onReserved`).
 */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Built-in MCP server names that configured servers may never use. The container boot path
 * (buildMcpServers) reserves these PLUS whatever built-ins it is actually handed; host-side
 * add paths (self-mod / CLI) reject them at write time for fail-loud UX. Host and container are
 * separate builds, so the host keeps a mirror of this set in src/mcp-reserved-names.ts — keep the
 * two in sync if a built-in name is ever added.
 */
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(['nanoclaw']);

export function isReservedMcpServerName(name: string): boolean {
  return RESERVED_MCP_SERVER_NAMES.has(name);
}

export function buildMcpServers(
  builtins: Record<string, McpServerSpec>,
  configured: Record<string, McpServerSpec>,
  onReserved?: (name: string) => void,
  onAdded?: (name: string, cfg: McpServerSpec) => void,
): Record<string, McpServerSpec> {
  const reserved = new Set([...RESERVED_MCP_SERVER_NAMES, ...Object.keys(builtins)]);
  const merged: Record<string, McpServerSpec> = { ...builtins };
  for (const [name, cfg] of Object.entries(configured)) {
    if (reserved.has(name)) {
      onReserved?.(name); // built-in is authoritative — never let config override it
      continue;
    }
    merged[name] = cfg;
    onAdded?.(name, cfg);
  }
  return merged;
}
