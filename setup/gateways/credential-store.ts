import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadGatewayCatalog } from './catalog.js';
import { resolveGatewaySelection } from './selection.js';

export const PROVIDER_CREDENTIAL_CONNECTION_SEAM_VERSION = 1;

/** Login belongs to the agent provider; custody and refresh belong to its gateway. */
export type ProviderCredential = { kind: 'api-key'; value: string } | { kind: 'oauth'; file: string };

/** A provider describes credential use; the selected gateway owns storage and refresh. */
export interface GatewayCredentialTarget {
  name: string;
  kind: 'api-key' | 'oauth';
  host: string;
  /** Non-secret marker emitted by the runtime, for gateways using selective replacement. */
  proxyValue?: string;
  injection?: { headerName: string; valueFormat: string };
  oauth?: { clientId: string; tokenEndpoint: string; accountHeader: string };
}

export interface GatewayOAuthCredential {
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

export interface GatewayCredentialConnection {
  /** False when keeping the current value cannot complete this connection. */
  readonly canKeep?: boolean;
  find(options?: { confirmHostChange: (previous: string, next: string) => Promise<boolean> }): Promise<string | null>;
  save(value: string | GatewayOAuthCredential, existingId: string | null): Promise<string>;
  keep(existingId: string): Promise<void>;
}

export interface ProviderCredentialStore {
  /** Validate an endpoint now; configure its gateway route after the user completes setup. */
  modelEndpoint?(url: string): { configure(): Promise<void> };
  connection?(target: GatewayCredentialTarget): GatewayCredentialConnection;
  has(provider: string): Promise<boolean>;
  save(provider: string, credential: ProviderCredential): Promise<void>;
}

export async function getCredentialStore(root = process.cwd()): Promise<ProviderCredentialStore> {
  const selected = process.env.NANOCLAW_GATEWAY_PROVIDER?.trim() || resolveGatewaySelection(root);
  const gateway = loadGatewayCatalog(root).gateways.find((entry) => entry.kind === selected);
  if (!gateway) throw new Error(`Unknown gateway: ${selected}`);
  const file = path.join(gateway.skillPath, 'scripts', 'credential-store.ts');
  if (!fs.existsSync(file)) throw new Error(`Gateway ${selected} does not provide a credential store`);
  const adapter = await import(pathToFileURL(file).href);
  const store = adapter.createCredentialStore?.(root);
  if (!store || typeof store.has !== 'function' || typeof store.save !== 'function')
    throw new Error(`Gateway ${selected} has an invalid credential store`);
  return store;
}

/** Resolve custody from the explicit gateway selection, never from a provider-specific fallback. */
export async function getCredentialConnection(
  target: GatewayCredentialTarget,
  root = process.cwd(),
): Promise<GatewayCredentialConnection> {
  const store = await getCredentialStore(root);
  if (!store.connection) throw new Error('The selected gateway does not support provider credential connections');
  const connection = store.connection(target);
  if (
    !connection ||
    ['find', 'save', 'keep'].some((key) => typeof connection[key as keyof GatewayCredentialConnection] !== 'function')
  )
    throw new Error('The selected gateway has an invalid provider credential connection');
  return connection;
}
