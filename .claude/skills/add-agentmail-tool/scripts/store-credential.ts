/**
 * Store the AgentMail API key in this install's credential gateway, scoped to
 * api.agentmail.to, through the gateway-neutral credential store. Containers
 * send `Authorization: Bearer gateway-managed`; the gateway swaps in the key.
 *
 * The key comes from AGENTMAIL_API_KEY in .env (the AgentMail channel's key)
 * or from stdin, never from argv:
 *   pnpm exec tsx .claude/skills/add-agentmail-tool/scripts/store-credential.ts
 *   pnpm exec tsx .claude/skills/add-agentmail-tool/scripts/store-credential.ts < key.txt
 * With neither, an existing gateway entry is kept as is.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { readEnvFile } from '../../../../src/env.js';
import {
  getCredentialStore,
  type GatewayCredentialTarget,
  type ProviderCredentialStore,
} from '../../../../setup/gateways/credential-store.js';

export const AGENTMAIL_TARGET: GatewayCredentialTarget = {
  name: 'AgentMail',
  host: 'api.agentmail.to',
  proxyValue: 'gateway-managed',
  kind: 'api-key',
  injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
};

export async function storeAgentMailCredential(
  store: ProviderCredentialStore,
  value: string | null,
): Promise<'saved' | 'kept'> {
  if (!store.connection) {
    throw new Error(
      'The installed gateway does not accept caller-described credentials. Add the AgentMail key in its ' +
        'console for host api.agentmail.to, injected as "Authorization: Bearer <key>".',
    );
  }
  const connection = store.connection(AGENTMAIL_TARGET);
  const found = await connection.find({ confirmHostChange: async () => false });
  if (value) {
    await connection.save(value);
    return 'saved';
  }
  if (found?.reusable) {
    await connection.keep();
    return 'kept';
  }
  throw new Error(
    'No AgentMail key: set AGENTMAIL_API_KEY in .env or pipe the key on stdin, then run this again.',
  );
}

function readKey(): string | null {
  const fromEnv = readEnvFile(['AGENTMAIL_API_KEY']).AGENTMAIL_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) return null;
  return fs.readFileSync(0, 'utf-8').trim() || null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  storeAgentMailCredential(await getCredentialStore(), readKey()).then(
    (result) => console.log(`AgentMail credential ${result} for ${AGENTMAIL_TARGET.host}`),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
