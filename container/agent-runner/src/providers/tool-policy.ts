/**
 * Provider tool-policy seam — INERT by default, MONOTONICALLY restrictive.
 *
 * An install-overlay can TIGHTEN the agent's tool surface without overwriting the
 * provider file. Registrations ACCUMULATE and compose so that — no matter how many
 * policies register, or in what order — the effective surface can only get MORE
 * restrictive, never less. A registrant can therefore never weaken another's denial:
 *   - `extraDenied`   — tools ADDED to the base denylist. Composed by UNION.
 *   - `allowTool`     — drop a tool from the base allowlist. Composed by AND (a tool
 *                       survives only if EVERY policy allows it).
 *   - `hideMcpServer` — hide an MCP server from the SDK. Composed by OR (hidden if ANY).
 *   - `settingSources`— restrict which CLAUDE.md setting layers the SDK reads. Composed
 *                       by INTERSECTION over the provider default (a registrant can only
 *                       REMOVE a source). This IS a security knob — a settings layer can
 *                       grant tools / register MCP servers — hence intersection, not replace.
 *
 * With no policy registered every accessor returns the provider's built-in default, so
 * default behaviour is identical to upstream.
 *
 * NOTE on `hideMcpServer`: hiding only drops a server from `this.mcpServers` + the
 * allowlist patterns. The SDK can still LOAD an MCP server from a settings source, so a
 * security-critical hide must ALSO be denied via `extraDenied` (e.g. `mcp__sqlite__*`
 * tool names) — the hide is presentation, the denylist is the boundary.
 */
export type SettingSource = 'project' | 'user' | 'local';

export interface ProviderToolPolicy {
  /** Tools ADDED to the base denylist. Additive (union) — cannot remove a base/other denial. */
  readonly extraDenied?: readonly string[];
  /** Return false to drop a tool from the base allowlist. Restrictive (AND) — cannot add a tool. */
  readonly allowTool?: (tool: string) => boolean;
  /** Return true to hide an MCP server. Additive hide (OR) — cannot reveal a hidden one. */
  readonly hideMcpServer?: (serverName: string) => boolean;
  /** Setting layers this registrant permits. Composed by intersection — cannot add a layer. */
  readonly settingSources?: readonly SettingSource[];
}

const policies: ProviderToolPolicy[] = [];

export function registerProviderToolPolicy(policy: ProviderToolPolicy): void {
  // Accumulate. Composition (below) is monotonically restrictive, so an extra
  // registrant can only tighten — there is no overwrite/replace path to weaken.
  policies.push(policy);
}

/** Effective additions to the provider's base denylist — the UNION across all registrants. */
export function policyExtraDenied(): string[] {
  return policies.flatMap((p) => p.extraDenied ?? []);
}

/** A base-allowlist tool survives iff EVERY registrant allows it (AND). */
export function policyAllowsTool(tool: string): boolean {
  return policies.every((p) => p.allowTool?.(tool) ?? true);
}

/** An MCP server is hidden iff ANY registrant hides it (OR). */
export function policyHidesMcpServer(serverName: string): boolean {
  return policies.some((p) => p.hideMcpServer?.(serverName) ?? false);
}

/** Effective SDK settingSources = base ∩ every registrant's permitted set (a registrant can
 *  only REMOVE a source). */
export function policySettingSources(base: readonly SettingSource[]): SettingSource[] {
  return policies.reduce<SettingSource[]>(
    (acc, p) => (p.settingSources ? acc.filter((s) => p.settingSources!.includes(s)) : acc),
    [...base],
  );
}

/** Test-only: reset the accumulated policies. */
export function __resetProviderToolPolicyForTest(): void {
  policies.length = 0;
}
