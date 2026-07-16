/**
 * Global provider override seam.
 *
 * `resolveProviderName()` (container-runner.ts) computes each agent group's
 * *native* provider and must stay pure — it has no idea a fallback module
 * might exist. This seam lets an optional module (src/modules/fallback)
 * wrap that native choice with an install-wide override, without the core
 * resolver ever importing from an optional module.
 *
 * No override registered → applyProviderOverride is the identity function,
 * so core behaves exactly as it did before this file existed.
 */
export type ProviderOverrideFn = (native: string) => string;

let overrideFn: ProviderOverrideFn | null = null;

/** Called once at module import time by the module that owns the override policy. */
export function registerGlobalProviderOverride(fn: ProviderOverrideFn): void {
  overrideFn = fn;
}

/** Applied at every provider-selection call site. Identity when no module is installed. */
export function applyProviderOverride(native: string): string {
  return overrideFn ? overrideFn(native) : native;
}
