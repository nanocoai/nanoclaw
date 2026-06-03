/**
 * Network policy provider registry.
 *
 * Singleton: at most one provider may be registered. Skills register on
 * import (top-level call) via `src/modules/network/index.ts`. Core call
 * sites use `getNetworkPolicyProvider()?.<hook>?.(…)` so an unregistered
 * registry is a true no-op.
 */
import type { NetworkPolicyProvider } from './types.js';

let provider: NetworkPolicyProvider | undefined;

export function registerNetworkPolicyProvider(p: NetworkPolicyProvider): void {
  if (provider) {
    throw new Error('A NetworkPolicyProvider is already registered');
  }
  provider = p;
}

export function getNetworkPolicyProvider(): NetworkPolicyProvider | undefined {
  return provider;
}

/** Test-only: drop the registered provider. Not for production code paths. */
export function resetNetworkPolicyProviderForTests(): void {
  provider = undefined;
}
