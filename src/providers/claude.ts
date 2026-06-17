/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * Two credential paths share this provider, distinguished by whether the
 * operator hands the container a gateway token:
 *
 *   - OneCLI-mediated (default). Setup stores the real token as a OneCLI
 *     generic secret and the container only sees a `placeholder` bearer that
 *     the proxy overwrites on the wire — the credential never enters the
 *     container.
 *   - Managed-fleet gateway. The container reaches a link-local LLM gateway
 *     that OneCLI is not in front of, so the bearer is presented as-is. See
 *     `composeAnthropicEnv` for how the token reaches the container.
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * Compose the container's Anthropic endpoint env for a custom base URL.
 *
 * The bearer token differs by credential path:
 *
 *  - **OneCLI-mediated (default).** The container sends a `placeholder` bearer;
 *    the OneCLI proxy rewrites it to the real credential on the wire, so the
 *    token never enters the container.
 *  - **Managed-fleet gateway.** The container talks to a link-local LLM gateway
 *    that OneCLI is not in front of, so nothing rewrites the bearer. The gateway
 *    authenticates by the token in the request itself, so the operator's
 *    `NANOCLAW_ANTHROPIC_AUTH_TOKEN` (a non-secret gateway sentinel) must reach
 *    the container verbatim. Without it the gateway answers
 *    `401 No credentials config`.
 *
 * Returns `{}` when no custom base URL is configured — standard
 * api.anthropic.com installs don't load this provider at all.
 */
export function composeAnthropicEnv(baseUrl: string | undefined, hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  if (!baseUrl) return {};
  const fleetToken = hostEnv.NANOCLAW_ANTHROPIC_AUTH_TOKEN?.trim();
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: fleetToken || 'placeholder',
  };
}

registerProviderContainerConfig('claude', (ctx) => {
  // Setup's custom-endpoint flow writes the base URL to .env; a managed-fleet
  // image may instead expose it (and the gateway token) purely as env vars.
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL']);
  const baseUrl = dotenv.ANTHROPIC_BASE_URL ?? ctx.hostEnv.NANOCLAW_ANTHROPIC_BASE_URL?.trim();
  return { env: composeAnthropicEnv(baseUrl, ctx.hostEnv) };
});
