/**
 * Host-side container config for the `claude` provider.
 *
 * The agent-runner reads CLAUDE_CODE_AUTO_COMPACT_WINDOW from the container
 * env, which the host builds from scratch. Pass the operator's value through
 * (service env, else `.env`, which the host does not load into process.env).
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

registerProviderContainerConfig('claude', (ctx) => {
  const value = ctx.hostEnv[KEY]?.trim() || readEnvFile([KEY])[KEY]?.trim();
  if (!value) return {};
  if (!/^[1-9]\d*$/.test(value)) {
    log.warn(`Ignoring ${KEY}: expected a positive integer token count`, { value });
    return {};
  }
  return { env: { [KEY]: value } };
});
