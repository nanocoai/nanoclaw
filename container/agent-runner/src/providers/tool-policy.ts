/**
 * Provider tool-policy seam — INERT on pristine core.
 *
 * An install-overlay can TIGHTEN the agent's tool surface without overwriting the
 * provider file. The seam is deliberately one-directional so a registrant can only
 * make the surface MORE restrictive, never less:
 *   - `extraDenied`   — tools ADDED to the provider's base denylist (never removes a base denial).
 *   - `allowTool`     — return false to DROP a tool from the base allowlist (never adds one).
 *   - `hideMcpServer` — return true to HIDE an MCP server from the SDK (never reveals one).
 *   - `settingSources`— REPLACE which CLAUDE.md setting layers the SDK reads (not a security knob).
 *
 * With no policy registered the provider uses its built-in defaults unchanged, so
 * pristine-core behaviour is identical to upstream. The denylist is the enforced
 * security boundary (a provider's `disallowedTools` wins over `allowedTools`); the
 * additive-only contract above is what keeps a registrant from weakening it.
 */
export interface ProviderToolPolicy {
  /** Tools ADDED to the provider's base denylist. Additive only — cannot remove a base denial. */
  readonly extraDenied?: readonly string[];
  /** Return false to drop a tool from the base allowlist. Restrictive only — cannot add a tool. */
  readonly allowTool?: (tool: string) => boolean;
  /** Return true to hide an MCP server from the SDK. Additive hide — cannot reveal a hidden one. */
  readonly hideMcpServer?: (serverName: string) => boolean;
  /** Replace the SDK `settingSources` (which CLAUDE.md setting layers the SDK reads). */
  readonly settingSources?: readonly ('project' | 'user' | 'local')[];
}

let registered: ProviderToolPolicy | null = null;

export function registerProviderToolPolicy(policy: ProviderToolPolicy): void {
  if (registered) console.error('[tool-policy] provider tool-policy overwritten');
  registered = policy;
}

export function getProviderToolPolicy(): ProviderToolPolicy | null {
  return registered;
}
