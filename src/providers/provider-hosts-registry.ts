/**
 * Per-provider API host registry.
 *
 * Used by network policy providers to decide what egress destinations
 * an agent must always be able to reach based on the provider it uses
 * (Anthropic API for `claude`, localhost for `ollama`, etc.). The
 * Squid-based provider, for example, unions these hosts into every
 * agent's allowlist regardless of the agent's `internet_access_policy`
 * bucket — without them, even an agent set to `model-only` would have
 * its model API calls blocked.
 *
 * Built-in defaults cover the providers shipped in core. Optional
 * provider skills (Ollama, OpenCode, etc.) register their hosts from
 * their own provider file via `registerProviderHosts()`.
 *
 * Hosts are stored as Squid `dstdomain`-style entries — leading dot
 * matches the domain and any subdomain (`.api.anthropic.com` matches
 * `api.anthropic.com` and `bedrock.api.anthropic.com`). Bare hostnames
 * also work.
 */

const BUILTIN_PROVIDER_HOSTS: Record<string, string[]> = {
  claude: ['.api.anthropic.com'],
};

const registry = new Map<string, string[]>(Object.entries(BUILTIN_PROVIDER_HOSTS).map(([k, v]) => [k, [...v]]));

/**
 * Register host(s) for a provider. Merges with any existing entries so
 * multiple sources can contribute to the same provider.
 */
export function registerProviderHosts(name: string, hosts: string[]): void {
  const key = name.toLowerCase();
  const existing = registry.get(key) ?? [];
  registry.set(key, Array.from(new Set([...existing, ...hosts])));
}

/** Lookup hosts for a provider. Returns empty array for unregistered providers. */
export function getProviderHosts(name: string): string[] {
  return registry.get(name.toLowerCase()) ?? [];
}

/** List every provider that has at least one host registered. */
export function listProvidersWithHosts(): string[] {
  return [...registry.keys()];
}

/** Test-only: clear non-built-in entries. Built-in defaults remain. */
export function resetProviderHostsForTests(): void {
  registry.clear();
  for (const [k, v] of Object.entries(BUILTIN_PROVIDER_HOSTS)) {
    registry.set(k, [...v]);
  }
}
