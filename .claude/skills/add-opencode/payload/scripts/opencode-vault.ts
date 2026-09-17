import { getCredentialStore } from '../setup/gateways/credential-store.js';
import type { GatewayCredentialConnection, GatewayCredentialTarget } from '../setup/gateways/credential-store.js';
import { OPENCODE_CREDENTIAL_PLACEHOLDER } from '../src/providers/opencode-auth-stub.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What OpenCode knows about a credential: destination, header scheme, and for ChatGPT its public OAuth client. */
export type OpenCodeSecret = DistributiveOmit<GatewayCredentialTarget, 'proxyValue'>;
export type OpenCodeVault = GatewayCredentialConnection;
export type KeyInjection = Extract<GatewayCredentialTarget, { kind: 'api-key' }>['injection'];

export function apiKeyInjection(provider: string): KeyInjection {
  if (provider === 'google') return { headerName: 'x-goog-api-key', valueFormat: '{value}' };
  if (provider === 'anthropic') return { headerName: 'x-api-key', valueFormat: '{value}' };
  if (['openai', 'openrouter', 'deepseek'].includes(provider))
    return { headerName: 'Authorization', valueFormat: 'Bearer {value}' };
  throw new Error(
    `API-key setup does not yet support the ${provider} authentication scheme. Choose openai, openrouter, deepseek, google, or anthropic. For an OpenAI-compatible service, choose Local or self-hosted.`,
  );
}

/**
 * Every OpenCode credential goes through the selected gateway's connection.
 * Resolution is lazy so setup can finish selecting the gateway before the
 * first credential prompt; there is no gateway-specific branch here and no
 * fallback when the selected gateway cannot connect.
 */
export function createOpenCodeVault(target: OpenCodeSecret, root = process.cwd()): OpenCodeVault {
  let connection: Promise<GatewayCredentialConnection> | undefined;
  const resolve = () =>
    (connection ??= getCredentialStore(root).then((store) => {
      if (!store.connection) throw new Error('The selected gateway does not support provider credential connections.');
      return store.connection({ ...target, proxyValue: OPENCODE_CREDENTIAL_PLACEHOLDER } as GatewayCredentialTarget);
    }));
  return {
    find: async (options) => (await resolve()).find(options),
    save: async (value) => (await resolve()).save(value),
    keep: async () => (await resolve()).keep(),
  };
}

// Matches the native OpenAI plugin in the skill-pinned OpenCode 1.18.25.
export const CHATGPT_SECRET: OpenCodeSecret = {
  name: 'OpenCode ChatGPT',
  kind: 'oauth',
  host: 'chatgpt.com',
  oauth: {
    profile: 'chatgpt',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
  },
};
