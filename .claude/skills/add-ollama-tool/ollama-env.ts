/**
 * Host-side env forwarding for the Ollama MCP tool. Returns the Docker `-e`
 * arguments that pass any `OLLAMA_*` host overrides into the container.
 *
 * Ollama is local and keyless — these are configuration, not credentials:
 * `OLLAMA_HOST` is the base URL of the host's Ollama daemon, and
 * `OLLAMA_ADMIN_TOOLS` is the opt-in flag for the library-management tools.
 *
 * Lives in its own file so the reach-in in `container-runner.ts` is a single
 * call (`args.push(...ollamaEnvArgs())`) and this logic is behavior-testable in
 * isolation, without invoking the OneCLI-entangled `buildContainerArgs`.
 */
export function ollamaEnvArgs(): string[] {
  const args: string[] = [];
  if (process.env.OLLAMA_HOST) {
    args.push('-e', `OLLAMA_HOST=${process.env.OLLAMA_HOST}`);
  }
  if (process.env.OLLAMA_ADMIN_TOOLS) {
    args.push('-e', `OLLAMA_ADMIN_TOOLS=${process.env.OLLAMA_ADMIN_TOOLS}`);
  }
  return args;
}
