import { mergeNoProxy, readDotEnv } from './env-helpers.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('ollama', (ctx) => {
  const env: Record<string, string> = {
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, 'host.docker.internal'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, 'host.docker.internal'),
  };

  // Read OLLAMA_* from process.env first, then from .env as fallback.
  const envFile = readDotEnv();
  for (const key of ['OLLAMA_BASE_URL', 'OLLAMA_MODEL'] as const) {
    const value = ctx.hostEnv[key] || envFile[key];
    if (value) env[key] = value;
  }
  return { env };
});
