import { getCredentialConnection } from '../setup/gateways/credential-store.js';
import type { GatewayCredentialConnection, GatewayCredentialTarget } from '../setup/gateways/credential-store.js';

export type OpenCodeSecret = GatewayCredentialTarget;
export type OpenCodeVault = GatewayCredentialConnection;
export type KeyInjection = NonNullable<GatewayCredentialTarget['injection']>;

export function apiKeyInjection(provider: string): KeyInjection {
  if (provider === 'google') return { headerName: 'x-goog-api-key', valueFormat: '{value}' };
  if (provider === 'anthropic') return { headerName: 'x-api-key', valueFormat: '{value}' };
  if (['openai', 'openrouter', 'deepseek'].includes(provider))
    return { headerName: 'Authorization', valueFormat: 'Bearer {value}' };
  throw new Error(
    `API-key setup does not yet support the ${provider} authentication scheme. Choose openai, openrouter, deepseek, google, or anthropic. For an OpenAI-compatible service, choose Local or self-hosted.`,
  );
}

/** Lazy resolution lets setup finish selecting the gateway before touching credentials. */
export function createOpenCodeVault(target: OpenCodeSecret, root = process.cwd()): OpenCodeVault {
  let active: GatewayCredentialConnection | undefined;
  let connection: Promise<GatewayCredentialConnection> | undefined;
  const resolve = () =>
    (connection ??= getCredentialConnection({ ...target, proxyValue: 'nc-opencode-token-v1' }, root).then(
      (value) => (active = value),
    ));
  return {
    get canKeep() {
      return active?.canKeep;
    },
    find: async (options) => (await resolve()).find(options),
    save: async (value, existingId) => (await resolve()).save(value, existingId),
    keep: async (existingId) => (await resolve()).keep(existingId),
  };
}

// Matches the native OpenAI plugin in the skill-pinned OpenCode 1.18.25.
export const CHATGPT_SECRET: OpenCodeSecret = {
  name: 'OpenCode ChatGPT',
  kind: 'oauth',
  host: 'chatgpt.com',
  oauth: {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    tokenEndpoint: 'https://auth.openai.com/oauth/token',
    accountHeader: 'ChatGPT-Account-Id',
  },
};
