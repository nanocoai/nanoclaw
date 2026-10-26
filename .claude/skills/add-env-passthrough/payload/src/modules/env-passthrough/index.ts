/**
 * Env passthrough module — forwards operator-listed, non-secret host env vars
 * into agent containers.
 *
 * The operator names the variables in `.env`:
 *
 *   CONTAINER_ENV_PASSTHROUGH=HTTP_TIMEOUT_MS,LOG_FORMAT
 *
 * Each spawn reads `.env` again, so a change applies to the next container
 * without a host restart. Credentials are never forwarded: a name or value
 * that looks like one is skipped with a warning — credentials stay with the
 * gateway. With the variable unset, the contributor returns nothing and a
 * spawn is unchanged.
 */
import { registerEnvContributor } from '../../container-env-contributors.js';
import { isSecretShaped } from '../../drivers/types.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { PASSTHROUGH_LIST_KEY, parsePassthroughList, selectPassthrough } from './passthrough.js';

registerEnvContributor('env-passthrough', () => {
  const names = parsePassthroughList(readEnvFile([PASSTHROUGH_LIST_KEY])[PASSTHROUGH_LIST_KEY]);
  if (names.length === 0) return {};
  const { env, skipped } = selectPassthrough(names, readEnvFile(names), isSecretShaped);
  for (const { name, reason } of skipped) {
    log.warn('env-passthrough: variable not forwarded', { name, reason });
  }
  return env;
});
