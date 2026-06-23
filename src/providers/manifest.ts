/**
 * Manifest provider container config — passes the Manifest endpoint URL
 * and a placeholder auth token into the container.
 *
 * The real API key (mnfst_*) never enters the container. Setup creates a
 * OneCLI generic secret (host-pattern = base URL hostname, header-name =
 * Authorization, value-format = "Bearer {value}") so the proxy rewrites
 * the Authorization header on the wire. The container only needs:
 *   - MANIFEST_BASE_URL — so the provider knows where to call
 *   - MANIFEST_AUTH_TOKEN=placeholder — so the provider adds an
 *     Authorization: Bearer header for OneCLI to overwrite
 */
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('manifest', () => {
  const dotenv = readEnvFile(['MANIFEST_BASE_URL']);
  const env: Record<string, string> = {};
  const baseUrl = dotenv.MANIFEST_BASE_URL ?? 'http://localhost:3001/v1';
  env.MANIFEST_BASE_URL = baseUrl;
  env.MANIFEST_AUTH_TOKEN = 'placeholder';
  return { env };
});
