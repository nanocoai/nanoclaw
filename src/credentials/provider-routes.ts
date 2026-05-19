/**
 * Provider route registry.
 *
 * Maps a logical provider id (`openai`, `anthropic`, `openrouter`, `google`,
 * `local`) to the upstream base URL the credential gateway forwards to.
 *
 * Purpose: let Codex / OpenCode / Pi / Cursor be configured with
 *   - a gateway base URL (e.g. `<gateway>/openai/v1`)
 *   - a placeholder token
 *   - provider/model metadata headers
 * while OneCLI or a local fallback proxy injects the real credential
 * outside the container.
 *
 * The registry is install-customizable: skills add routes by calling
 * `registerProviderRoute`. Trunk pre-registers no routes — OneCLI today
 * handles routing via per-secret host patterns, not URL prefixes. Routes
 * exist for future gateway implementations that want path-prefix routing
 * (matching the gccourse credential-proxy pattern).
 */
export interface ProviderRoute {
  id: string;
  baseUrl: string;
}

const routes = new Map<string, ProviderRoute>();

export function registerProviderRoute(id: string, baseUrl: string): void {
  if (routes.has(id)) {
    throw new Error(`Provider route already registered: ${id}`);
  }
  routes.set(id, { id, baseUrl });
}

export function getProviderRoute(id: string): ProviderRoute | undefined {
  return routes.get(id);
}

export function listProviderRoutes(): ProviderRoute[] {
  return [...routes.values()];
}

/** Test-only — clears the registry between cases. Not exported from index.ts. */
export function __resetProviderRoutesForTest(): void {
  routes.clear();
}
