/**
 * Turn a list of credential decisions into container contributions
 * (env + mounts) and/or a refusal.
 *
 * Container-runner calls this once at spawn time with all decisions for
 * the session. The first `forbidden` or `connect_required` short-circuits
 * the result into a refusal; container-runner then refuses to spawn and
 * surfaces the refusal to the user. `gateway_secret` and `native_auth_bundle`
 * accumulate into the contribution. `fallback` is a no-op — container-runner
 * falls through to the existing `ProviderContainerConfigFn` for that provider.
 *
 * Env wiring for `gateway_secret` is keyed by `providerId`:
 *   anthropic  -> ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 *   openai     -> OPENAI_BASE_URL + OPENAI_API_KEY
 *   openrouter -> OPENROUTER_BASE_URL + OPENROUTER_API_KEY
 *   google     -> GOOGLE_BASE_URL + GOOGLE_API_KEY
 * Anything else falls through with no env contribution — the provider's
 * registered container config fn is responsible for SDK env wiring.
 */
import type { CredentialDecision } from './types.js';
import { materializeNativeAuthBundle } from './bundle-materializer.js';
import type { ProviderContainerContribution, VolumeMount } from '../providers/provider-container-registry.js';

export type CredentialRefusal =
  | { kind: 'forbidden'; provider: string; reason?: string }
  | { kind: 'connect_required'; provider: string; message: string; connectUrl?: string };

export interface ApplyResult {
  contribution: Required<Pick<ProviderContainerContribution, 'mounts' | 'env'>>;
  refusal: CredentialRefusal | null;
}

const GATEWAY_ENV_MAP: Record<string, { baseUrl: string; token: string }> = {
  anthropic: { baseUrl: 'ANTHROPIC_BASE_URL', token: 'ANTHROPIC_AUTH_TOKEN' },
  openai: { baseUrl: 'OPENAI_BASE_URL', token: 'OPENAI_API_KEY' },
  openrouter: { baseUrl: 'OPENROUTER_BASE_URL', token: 'OPENROUTER_API_KEY' },
  google: { baseUrl: 'GOOGLE_BASE_URL', token: 'GOOGLE_API_KEY' },
};

export function applyCredentialDecisions(
  decisions: CredentialDecision[],
  sessionDir: string,
  hostEnv: NodeJS.ProcessEnv,
): ApplyResult {
  const mounts: VolumeMount[] = [];
  const env: Record<string, string> = {};

  for (const decision of decisions) {
    switch (decision.kind) {
      case 'fallback':
        continue;
      case 'forbidden':
        return {
          contribution: { mounts: [], env: {} },
          refusal: {
            kind: 'forbidden',
            provider: decision.provider,
            ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          },
        };
      case 'connect_required':
        return {
          contribution: { mounts: [], env: {} },
          refusal: {
            kind: 'connect_required',
            provider: decision.provider,
            message: decision.message,
            ...(decision.connectUrl !== undefined ? { connectUrl: decision.connectUrl } : {}),
          },
        };
      case 'gateway_secret': {
        const mapping = GATEWAY_ENV_MAP[decision.providerId];
        if (mapping && decision.baseUrl) {
          env[mapping.baseUrl] = decision.baseUrl;
          env[mapping.token] = decision.placeholderToken ?? 'placeholder';
        }
        break;
      }
      case 'native_auth_bundle': {
        const result = materializeNativeAuthBundle(decision, sessionDir, hostEnv);
        if (result.ok) {
          mounts.push(result.mount);
        }
        // Soft-fail: a missing bundle (missing host file, unsupported scheme,
        // copy error) skips the mount but never aborts the session. The
        // vendor runtime inside the container will surface the missing-auth
        // error in its own terms; aborting here would mask it behind a
        // generic "credential resolver failed."
        break;
      }
      default: {
        // Compile-time exhaustiveness check. If a new CredentialDecision
        // kind is added to types.ts, TypeScript will fail this assignment
        // and force a corresponding case here. Runtime no-op.
        const _exhaustive: never = decision;
        void _exhaustive;
      }
    }
  }

  return { contribution: { mounts, env }, refusal: null };
}
