/**
 * Offline gateway provider for the in-tree harnesses. Contributes nothing.
 *
 * The real gateway (`onecli`) calls out to the vault on every spawn: it
 * registers the agent, then fetches the per-session credential contribution,
 * and a throw there aborts the spawn on purpose — "a session without its
 * gateway is a session without credentials, and it must not launch". Correct
 * in production, and it means the harnesses below cannot spawn a single
 * container on a machine with no vault: they stop at
 * `wakeContainer failed ... OneCLIRequestError` having proved only the
 * routing half.
 *
 * This registers a no-credential gateway under the kind `harness-noop` so a
 * harness run can exercise the whole spawn path — spec composition, mount
 * admission, `docker create/start`, the runner's first poll of inbound.db —
 * without any credential at all. Select it explicitly:
 *
 *   NANOCLAW_GATEWAY_PROVIDER=harness-noop pnpm exec tsx scripts/test-v2-host.ts
 *
 * Safety: the registration lives in `scripts/`, which nothing under `src/`
 * imports, so the host cannot select this kind however the variable is set —
 * `getGatewayProvider()` finds no factory and throws its operator error. The
 * agent it spawns has no proxy env and no credential stubs, so a provider
 * that needs a key fails on its first call. That is the point: use this to
 * verify plumbing, not to run an agent.
 */
import { registerGatewayProvider } from '../src/gateway-providers/gateway-provider-registry.js';

export const HARNESS_NOOP_GATEWAY_KIND = 'harness-noop';

registerGatewayProvider(HARNESS_NOOP_GATEWAY_KIND, () => ({
  kind: HARNESS_NOOP_GATEWAY_KIND,
  async contribute() {
    return {};
  },
}));
