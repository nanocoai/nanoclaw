/**
 * Provider-agnostic credential resolver hook.
 *
 * Trunk default returns `{ kind: 'fallback' }` so solo installs behave
 * exactly like they do today: container-runner falls back to the existing
 * provider config fn + OneCLI gateway. Course / classroom / multi-tenant
 * skills register a real resolver via `setCredentialResolverHook`.
 *
 * The hook is process-global. Process-global is correct for the single-host
 * NanoClaw architecture (one Node process owns all routing). If the host
 * is ever split into worker_threads or a multi-process model, this needs
 * to move to a per-context registry.
 *
 * Tests use `resetCredentialResolverHook` in `afterEach` to avoid bleed
 * between cases.
 */
import type { CredentialDecision, CredentialResolverHook, CredentialResolverInput } from './types.js';

const defaultHook: CredentialResolverHook = async () => ({ kind: 'fallback' });

let activeHook: CredentialResolverHook = defaultHook;

/**
 * Install a resolver hook. Single-slot — if a hook is already installed,
 * it is silently overwritten. This is intentional: the resolver is a
 * site-level policy override, not a registry. Two callers competing for
 * the slot is a configuration bug; resolve it at the install layer, not
 * here.
 */
export function setCredentialResolverHook(hook: CredentialResolverHook): void {
  activeHook = hook;
}

/**
 * Restore the default fallback hook. Primarily a test cleanup helper —
 * `afterEach(() => resetCredentialResolverHook())` keeps state from
 * leaking between cases. Exported from the public barrel because tests
 * in other files (apply, container-runner, scenario) need it too.
 * Production callers have no reason to invoke this.
 */
export function resetCredentialResolverHook(): void {
  activeHook = defaultHook;
}

export function resolveCredential(input: CredentialResolverInput): Promise<CredentialDecision> {
  return activeHook(input);
}
