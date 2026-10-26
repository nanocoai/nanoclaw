/**
 * Host-side env forwarding for the llmman MCP tool: any `LLMMAN_*` overrides
 * the tool understands, as spec-shaped env (a record) — argv never crosses
 * composition anymore.
 *
 * - `LLMMAN_HOST` — where the daemon is, in llmman's own `[scheme://][host][:port]`
 *   spelling. The MCP server resolves it from inside the container.
 * - `LLMMAN_API_KEY` — the key llmman's own CLI presents to a daemon that has
 *   `LLMMAN_API_KEYS` set. Sent as `Authorization: Bearer`. Never forward the
 *   plural `LLMMAN_API_KEYS`: that is the daemon's whole key set.
 * - `LLMMAN_ADMIN_TOOLS` — opt-in flag for the library-management tools (a
 *   NanoClaw skill flag, not an llmman setting).
 *
 * The reach-in spreads this into the CONTRIBUTED env lane
 * (`ContainerSpec.contributedEnv`), not the composed literal: `LLMMAN_API_KEY`
 * is credential-NAMED, and the composed lane's key-name check would refuse it
 * and deny the spawn. The contributed lane exempts the name and still refuses
 * credential-shaped VALUES — the right rule for a local service key.
 *
 * Each value comes from the host process environment first, then from the
 * project `.env`: the host never loads `.env` into `process.env`
 * (see `readEnvFile`), so reading only `process.env` would ignore the lines the
 * skill tells the operator to add there.
 *
 * Lives in its own file so the reach-in in `container-runner.ts` is a single
 * spread and this logic is behavior-testable in isolation.
 */
import { readEnvFile } from './env.js';

const FORWARDED = ['LLMMAN_HOST', 'LLMMAN_API_KEY', 'LLMMAN_ADMIN_TOOLS'] as const;

export function llmmanEnv(projectRoot?: string): Record<string, string> {
  const fromDotenv = readEnvFile([...FORWARDED], projectRoot);
  const env: Record<string, string> = {};
  for (const key of FORWARDED) {
    const value = process.env[key] || fromDotenv[key];
    if (value) env[key] = value;
  }
  return env;
}
