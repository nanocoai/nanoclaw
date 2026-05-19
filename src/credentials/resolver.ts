/**
 * Provider-agnostic credential resolver hook.
 *
 * Trunk default returns `{ kind: 'fallback' }` so solo installs behave
 * exactly like they do today: container-runner falls back to the existing
 * provider config fn + OneCLI gateway. Course / classroom / multi-tenant
 * skills register a real resolver via `setCredentialResolverHook`.
 *
 * The hook is process-global. Tests use `resetCredentialResolverHook` in
 * `afterEach` to avoid bleed between cases.
 */
import type { CredentialDecision, CredentialResolverHook, CredentialResolverInput } from './types.js';

const defaultHook: CredentialResolverHook = async () => ({ kind: 'fallback' });

let activeHook: CredentialResolverHook = defaultHook;

export function setCredentialResolverHook(hook: CredentialResolverHook): void {
  activeHook = hook;
}

export function resetCredentialResolverHook(): void {
  activeHook = defaultHook;
}

export function resolveCredential(input: CredentialResolverInput): Promise<CredentialDecision> {
  return activeHook(input);
}
