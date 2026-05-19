/**
 * Provider-agnostic credential decision model.
 *
 * Resolvers return one of these shapes for a given (agentGroupId,
 * runtimeProvider, modelProvider, modelId, authMode, targetHost, targetPath,
 * operation) tuple. Container-runner branches on `kind` at spawn time.
 *
 * - gateway_secret: secret OneCLI/gateway will inject at request time.
 *   Container only sees a placeholder + base URL.
 * - native_auth_bundle: file/directory the vendor runtime owns (Codex
 *   auth.json, future Pi auth bundle). Materialized to a per-session path
 *   and mounted into the container. Runtime refreshes its own state.
 * - connect_required: caller (user/agent group) must connect a provider
 *   account first. Surfaces as 402 (or 409) on the proxy and as a spawn
 *   refusal in container-runner.
 * - forbidden: provider/model not allowed for this agent group. 403.
 * - fallback: no override — use the existing provider config fn / env
 *   path. Trunk's default resolver always returns this.
 *
 * Field-name convention: `gateway_secret` and `native_auth_bundle` use
 * `providerId` because the value is a registry key (looked up against
 * `GATEWAY_ENV_MAP` and the provider-routes registry). `connect_required`
 * and `forbidden` use `provider` because the value is surfaced verbatim
 * in error envelopes (`{ type: 'forbidden', provider: '...' }`) — it is
 * a message-facing label, not a registry lookup. Resolver authors can
 * use the same string for both when their concept of "provider" is
 * unified; the two names exist to keep the two roles legible.
 */
export type CredentialDecision =
  | {
      kind: 'gateway_secret';
      providerId: string;
      secretRef?: string;
      baseUrl?: string;
      /**
       * Value the container sees in env (`OPENAI_API_KEY=…`,
       * `ANTHROPIC_AUTH_TOKEN=…`). The gateway rewrites the real
       * Authorization header on the wire. If omitted, `applyCredentialDecisions`
       * substitutes the literal string `'placeholder'` — fine for SDKs
       * that just need a non-empty token to send. Set it explicitly when
       * a specific sentinel is meaningful (e.g. OAuth exchange flows that
       * key on a known placeholder).
       */
      placeholderToken?: string;
      injection?: {
        header: 'authorization' | 'x-api-key' | string;
        scheme?: 'Bearer' | string;
      };
      refreshPolicy?: 'gateway';
    }
  | {
      kind: 'native_auth_bundle';
      providerId: string;
      /**
       * Where the bundle currently lives. Two formats today:
       *   `host:<absolute-or-tilde-path>` — host filesystem.
       *   `onecli:<bundle-id>` — reserved for future OneCLI bundle storage.
       */
      bundleRef: string;
      /** Where to mount the bundle inside the container. */
      mountPath: string;
      readonly?: boolean;
      refreshPolicy: 'runtime';
      /**
       * If true, after the runtime refreshes its own auth state, sync the
       * updated bundle back into bundle storage. Not implemented for the
       * `host:` scheme yet — runtime writes are visible directly through
       * the mount. Reserved for `onecli:` scheme.
       */
      syncBack?: boolean;
    }
  | {
      kind: 'connect_required';
      provider: string;
      message: string;
      connectUrl?: string;
    }
  | {
      kind: 'forbidden';
      provider: string;
      reason?: string;
    }
  | { kind: 'fallback' };

export interface CredentialResolverInput {
  agentGroupId: string;
  runtimeProvider: string;
  modelProvider?: string;
  modelId?: string;
  authMode?: 'auto' | 'api_key' | 'subscription' | 'oauth' | 'native';
  targetHost?: string;
  targetPath?: string;
  operation?: string;
}

export type CredentialResolverHook = (input: CredentialResolverInput) => Promise<CredentialDecision>;
