/**
 * Host-side container config for the `pi` provider.
 *
 * pi resolves models and credentials exclusively from its agentDir files —
 * its SDK reads no environment variables for auth. The host declares that
 * directory as a group state volume (see `src/provider-contracts/pi.ts`) and
 * passes `PI_AGENT_DIR`; the container-side provider
 * (`container/agent-runner/src/providers/pi.ts`) points pi at it.
 *
 * Credentials are **not** copied here. The container writes fixed
 * `gateway-managed` placeholders into the agentDir before every session open,
 * and the selected gateway swaps in the real token or key on the wire (see
 * `container/agent-runner/src/providers/pi-auth.ts`). Nothing in `.env` or the
 * spawn environment carries a credential. Existing real logins already in the
 * group's shared agentDir are preserved.
 *
 * Non-secret model configuration (`settings.json`, `models.json`) is
 * operator-owned and lives in the same group volume.
 *
 * The only env this adapter contributes is `PI_AGENT_DIR`, plus the optional,
 * operator-set `PI_GATEWAY_PROVIDERS` list naming the pi provider ids the
 * gateway holds credentials for, so the container writes exactly those
 * placeholders. The provider's mounts are realized by core from the host
 * contract, so this adapter returns env only.
 */
import { readEnvFile } from '../env.js';

import { registerProviderContainerConfig } from './provider-container-registry.js';

const CONTAINER_PI_AGENT_DIR = '/home/node/.pi/agent';
const GATEWAY_PROVIDERS_KEY = 'PI_GATEWAY_PROVIDERS';

/**
 * The host process does not load `.env` into `process.env`, so a value the
 * operator saved without exporting it is only visible through `readEnvFile`;
 * a real exported variable still wins. Same fallback the opencode adapter uses.
 */
function configuredGatewayProviders(hostEnv: NodeJS.ProcessEnv): string | undefined {
  const value = hostEnv[GATEWAY_PROVIDERS_KEY] ?? readEnvFile([GATEWAY_PROVIDERS_KEY])[GATEWAY_PROVIDERS_KEY];
  return value?.trim() || undefined;
}

registerProviderContainerConfig('pi', (ctx) => {
  const gatewayProviders = configuredGatewayProviders(ctx.hostEnv);
  return {
    env: {
      PI_AGENT_DIR: CONTAINER_PI_AGENT_DIR,
      ...(gatewayProviders ? { [GATEWAY_PROVIDERS_KEY]: gatewayProviders } : {}),
    },
  };
});
