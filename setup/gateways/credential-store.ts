import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadGatewayCatalog } from './catalog.js';
import { resolveGatewaySelection } from './selection.js';

/** Bumped only when a provider needs a gateway capability an older core's store cannot offer. */
export const PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = 1;

/** Login belongs to the agent provider; custody and refresh belong to its gateway. */
export type ProviderCredential = { kind: 'api-key'; value: string } | { kind: 'oauth'; file: string };

/**
 * The one OAuth profile every installed gateway can hold: OpenAI's ChatGPT
 * subscription login. It refreshes at a public token endpoint with a public
 * client id, authenticates with a bearer access token, and routes with an
 * account id the gateway presents in its own header. A gateway that receives
 * any other profile must reject it; nothing here describes OAuth in general.
 */
export interface ChatGptOAuthCredential {
  profile: 'chatgpt';
  accessToken: string;
  refreshToken: string;
  accountId: string;
}
export type GatewayOAuthCredential = ChatGptOAuthCredential;

/**
 * What a provider knows about a credential it cannot name by provider alone:
 * where it goes, how the request carries it, and the non-secret value the
 * runtime presents in its place. Storage, native ids, grants, and refresh
 * scheduling stay inside the gateway.
 */
export type GatewayCredentialTarget = {
  /** Gateway-visible label; one connection per name. */
  name: string;
  /** Exact DNS hostname the credential is scoped to. */
  host: string;
  /** Non-secret marker the runtime sends; gateways doing selective replacement match it. */
  proxyValue: string;
} & (
  | { kind: 'api-key'; injection: { headerName: string; valueFormat: string } }
  | { kind: 'oauth'; oauth: { profile: 'chatgpt'; clientId: string; tokenEndpoint: string } }
);

export interface GatewayCredentialConnection {
  /**
   * Read-only. `null` when nothing is stored. `reusable: false` means the
   * stored entry exists but `keep()` cannot complete it (an expired refresh,
   * a host move the gateway cannot apply without the value), so the caller
   * must supply a value. A stored entry on a different host is offered
   * through `confirmHostChange`; without a confirmation the lookup fails.
   */
  find(options?: {
    confirmHostChange: (previous: string, next: string) => Promise<boolean>;
  }): Promise<{ reusable: boolean } | null>;
  /** Store or replace the value for the entry `find()` observed, preserving its identity and grants. */
  save(value: string | GatewayOAuthCredential): Promise<void>;
  /** Reconcile the entry `find()` observed without a new value. */
  keep(): Promise<void>;
}

export interface ProviderCredentialStore {
  has(provider: string): Promise<boolean>;
  save(provider: string, credential: ProviderCredential): Promise<void>;
  /** Caller-described credentials. Absent when the gateway supports only provider-named ones. */
  connection?(target: GatewayCredentialTarget): GatewayCredentialConnection;
  /** Validate a model endpoint now; route it through the gateway after the user completes setup. */
  modelEndpoint?(url: string): { configure(): Promise<void> };
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

export async function getCredentialStore(root = process.cwd()): Promise<ProviderCredentialStore> {
  const selected = process.env.NANOCLAW_GATEWAY_PROVIDER?.trim() || resolveGatewaySelection(root);
  const gateway = loadGatewayCatalog(root).gateways.find((entry) => entry.kind === selected);
  if (!gateway) throw new Error(`Unknown gateway: ${selected}`);
  const file = path.join(gateway.skillPath, 'scripts', 'credential-store.ts');
  if (!fs.existsSync(file)) throw new Error(`Gateway ${selected} does not provide a credential store`);
  const adapter = await import(pathToFileURL(file).href);
  const store = adapter.createCredentialStore?.(root);
  if (
    !store ||
    !isFunction(store.has) ||
    !isFunction(store.save) ||
    (store.connection !== undefined && !isFunction(store.connection)) ||
    (store.modelEndpoint !== undefined && !isFunction(store.modelEndpoint))
  )
    throw new Error(`Gateway ${selected} has an invalid credential store`);
  if (!store.connection) return store;
  // The adapter is loaded dynamically; check the connection shape once here so
  // a provider never has to reason about a half-implemented gateway.
  const connection = store.connection.bind(store);
  return {
    ...store,
    connection(target) {
      const result = connection(target);
      if (!result || !isFunction(result.find) || !isFunction(result.save) || !isFunction(result.keep))
        throw new Error(`Gateway ${selected} has an invalid provider credential connection`);
      return result;
    },
  };
}
