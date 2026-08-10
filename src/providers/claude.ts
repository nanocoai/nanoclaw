/**
 * Claude provider container config — only registered when the user has
 * configured a custom Anthropic-compatible endpoint via setup. Setup
 * appends `import './claude.js'` to providers/index.ts at that point;
 * standard installs hitting api.anthropic.com don't need this file
 * loaded.
 *
 * The real auth token never enters the container. Setup creates an
 * OneCLI generic secret (host-pattern = base URL hostname, header-name
 * = Authorization, value-format = "Bearer {value}") so the proxy
 * rewrites the Authorization header on the wire. The container only
 * needs:
 *   - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *   - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', 'ANTHROPIC_BASE_URL_NO_PROXY']);
  const env: Record<string, string> = {};
  const blockedHosts: string[] = [];

  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';

    // Local-model case (e.g. Ollama): the endpoint needs no credentials, so
    // routing it through OneCLI buys nothing and its HTTPS proxy can't reach a
    // plain-http host on the LAN anyway. Opt-in, because the default above is
    // the opposite contract — a cloud endpoint whose Authorization header
    // OneCLI rewrites on the wire. Bypassing the proxy there would send the
    // placeholder token instead of the real one.
    if (dotenv.ANTHROPIC_BASE_URL_NO_PROXY === 'true') {
      const { hostname } = new URL(dotenv.ANTHROPIC_BASE_URL);
      env.NO_PROXY = hostname;
      env.no_proxy = hostname; // lowercase variant — some clients only read this one
      // With the proxy bypassed for the model host, a model name that drifts
      // back to a Claude one would still reach api.anthropic.com *through*
      // OneCLI, which injects the real key and bills it. Make it unreachable.
      blockedHosts.push('api.anthropic.com');
    }
  }

  return { env, blockedHosts };
});
