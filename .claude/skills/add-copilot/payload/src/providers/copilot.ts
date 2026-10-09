import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const FORWARDED_KEYS = ['COPILOT_MODEL', 'COPILOT_API_URL'] as const;

// Non-secret settings only. The device-login token stays in the credential
// gateway (scripts/copilot-login.ts); the container sends a placeholder.
registerProviderContainerConfig('copilot', ({ hostEnv }) => {
  const fileEnv = readEnvFile([...FORWARDED_KEYS]);
  const env: Record<string, string> = {};
  for (const key of FORWARDED_KEYS) {
    const value = hostEnv[key] ?? fileEnv[key];
    if (value) {
      env[key] = value;
    }
  }
  return { env: Object.keys(env).length > 0 ? env : undefined };
});
