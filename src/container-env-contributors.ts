/**
 * Container env contributors.
 *
 * Code that needs to add per-spawn env to an agent container — without owning
 * a model provider or the install's gateway — registers a contributor here.
 * Composition calls every contributor, in registration order, and merges the
 * results into the contributed lane (`ContainerSpec.contributedEnv`).
 *
 * Precedence on that lane, lowest to highest: the model provider's
 * contribution, then contributors (later registrations win), then the
 * gateway. The gateway stays last so it keeps the override it already has.
 *
 * Contributed values get no special treatment: `validateSpec` still refuses a
 * credential VALUE on this lane, so a contributor cannot carry a secret.
 *
 * With nothing registered, composition is unchanged.
 */
import type { ContainerConfig } from './container-config.js';

export interface ContainerEnvContext {
  agentGroupId: string;
  sessionId: string;
  containerConfig: ContainerConfig;
}

export type ContainerEnvContributor = (ctx: ContainerEnvContext) => Record<string, string>;

const contributors = new Map<string, ContainerEnvContributor>();

export function registerEnvContributor(name: string, fn: ContainerEnvContributor): void {
  if (contributors.has(name)) {
    throw new Error(`Container env contributor already registered: ${name}`);
  }
  contributors.set(name, fn);
}

/** Merge every contributor's env, in registration order. */
export function collectContributedEnv(ctx: ContainerEnvContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const fn of contributors.values()) Object.assign(env, fn(ctx));
  return env;
}

export function resetEnvContributorsForTesting(): void {
  contributors.clear();
}
