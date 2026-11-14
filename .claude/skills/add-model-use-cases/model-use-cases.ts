/**
 * Model use cases: a group's model may name a role instead of a model.
 *
 * `ncl groups config update --model usecase:coding` stores the token; the
 * host resolves it here each time it materializes container.json, from
 * `NANOCLAW_USE_CASE_MODEL_CODING` in the process environment or `.env`.
 * Swapping the model every coding group runs is then one `.env` line and a
 * restart of those groups, not one `ncl` call per group.
 *
 * Installed by `/add-model-use-cases`.
 */
import { readEnvFile } from './env.js';
import { log } from './log.js';

const TOKEN_PREFIX = 'usecase:';
const USE_CASE_NAME = /^[a-z][a-z0-9-]*$/;

/** The environment variable that names the model for a use case. */
export function useCaseModelVar(useCase: string): string {
  return `NANOCLAW_USE_CASE_MODEL_${useCase.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Resolve a stored model value. Anything that is not a `usecase:<name>` token
 * passes through unchanged. A token resolves to its configured model; an
 * unknown or malformed one resolves to `undefined` (the provider's default
 * model) with a warning, so the literal token never reaches a provider.
 */
export function resolveModelUseCase(model: string | undefined, groupName: string): string | undefined {
  if (model === undefined || !model.startsWith(TOKEN_PREFIX)) return model;

  const useCase = model.slice(TOKEN_PREFIX.length);
  if (!USE_CASE_NAME.test(useCase)) {
    log.warn('Model use case name is malformed; using the provider default model', { group: groupName, model });
    return undefined;
  }

  const key = useCaseModelVar(useCase);
  const resolved = (process.env[key] || readEnvFile([key])[key] || '').trim();
  if (!resolved) {
    log.warn('Model use case is not configured; using the provider default model', { group: groupName, key });
    return undefined;
  }
  return resolved;
}
