/**
 * Host-side env forwarding for the Atomic Chat MCP tool: any `ATOMIC_CHAT_*`
 * host overrides, as spec-shaped env (a record) — argv never crosses
 * composition anymore.
 *
 * The reach-in spreads this into the CONTRIBUTED env lane
 * (`ContainerSpec.contributedEnv`), not the composed literal:
 * `ATOMIC_CHAT_API_KEY` is credential-NAMED, and the composed lane's key-name
 * check would refuse it and deny the spawn. The contributed lane exempts the
 * name and still refuses credential-shaped VALUES — which is the right rule
 * for a local service token.
 *
 * Lives in its own file so the reach-in in `container-runner.ts` is a single
 * spread and this logic is behavior-testable in isolation.
 */
export function atomicChatEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ATOMIC_CHAT_HOST) {
    env.ATOMIC_CHAT_HOST = process.env.ATOMIC_CHAT_HOST;
  }
  if (process.env.ATOMIC_CHAT_API_KEY) {
    env.ATOMIC_CHAT_API_KEY = process.env.ATOMIC_CHAT_API_KEY;
  }
  return env;
}
