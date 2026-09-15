import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadGatewayCatalog } from './catalog.js';
import { resolveGatewaySelection } from './selection.js';

/** Login belongs to the agent provider; custody and refresh belong to its gateway. */
export type ProviderCredential = { kind: 'api-key'; value: string } | { kind: 'oauth'; file: string };

export interface ProviderCredentialStore {
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
