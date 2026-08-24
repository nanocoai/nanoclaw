/**
 * Host-side env forwarding for the Ollama MCP tool: any `OLLAMA_*` host
 * overrides, as spec-shaped env (a record) — argv never crosses composition
 * anymore.
 *
 * Ollama is local and keyless — these are configuration, not credentials:
 * `OLLAMA_HOST` is the base URL of the host's Ollama daemon, and
 * `OLLAMA_ADMIN_TOOLS` is the opt-in flag for the library-management tools.
 * Neither is credential-named, so the reach-in spreads this into the composed
 * `env` literal in `composeSessionSpec`.
 *
 * Lives in its own file so the reach-in in `container-runner.ts` is a single
 * spread and this logic is behavior-testable in isolation.
 */
export function ollamaEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.OLLAMA_HOST) {
    env.OLLAMA_HOST = process.env.OLLAMA_HOST;
  }
  if (process.env.OLLAMA_ADMIN_TOOLS) {
    env.OLLAMA_ADMIN_TOOLS = process.env.OLLAMA_ADMIN_TOOLS;
  }
  return env;
}
