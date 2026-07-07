/**
 * Host-side env forwarding for the Atomic Chat MCP tool. Returns the Docker `-e`
 * arguments that pass any `ATOMIC_CHAT_*` host overrides into the container.
 *
 * Lives in its own file so the reach-in in `container-runner.ts` is a single call
 * (`args.push(...atomicChatEnvArgs())`) and this logic is behavior-testable in
 * isolation, without invoking the OneCLI-entangled `buildContainerArgs`.
 */
export function atomicChatEnvArgs(): string[] {
  const args: string[] = [];
  if (process.env.ATOMIC_CHAT_HOST) {
    args.push('-e', `ATOMIC_CHAT_HOST=${process.env.ATOMIC_CHAT_HOST}`);
  }
  if (process.env.ATOMIC_CHAT_API_KEY) {
    args.push('-e', `ATOMIC_CHAT_API_KEY=${process.env.ATOMIC_CHAT_API_KEY}`);
  }
  return args;
}
