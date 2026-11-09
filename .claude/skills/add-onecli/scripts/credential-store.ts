import { createProviderCredentialConnection } from './provider-credentials.js';
import {
  createdSecretId,
  hasProviderCredential,
  recordProviderCredentials,
} from '../payload/src/gateway-providers/onecli-provider-credentials.js';
import { getProviderModelEndpoint } from '../../../../src/provider-contracts/index.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';

export function createCredentialStore(root = process.cwd()): ProviderCredentialStore {
  const check = (provider: string) => {
    if (provider !== 'codex') throw new Error(`OneCLI credential adapter does not support ${provider}`);
  };
  return {
    connection: (target) => createProviderCredentialConnection(target, root),
    connectionPaths: true,
    // Connected means Codex groups will be granted a recorded credential.
    async has(provider) {
      check(provider);
      let secrets: Array<{ id?: string; name?: string; type?: string }>;
      try {
        const parsed = JSON.parse(
          execFileSync('onecli', ['secrets', 'list', '--max', '0'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        );
        secrets = (Array.isArray(parsed) ? parsed : parsed.data) ?? [];
      } catch {
        throw new Error('Cannot read the selected OneCLI vault; check that OneCLI is running.');
      }
      return hasProviderCredential(path.join(root, 'data'), provider, secrets);
    },
    async save(provider, credential) {
      check(provider);
      const temporary =
        credential.kind === 'api-key' ? fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-codex-')) : undefined;
      let output: string;
      try {
        const file = credential.kind === 'oauth' ? credential.file : path.join(temporary!, 'key');
        if (credential.kind === 'api-key') fs.writeFileSync(file, credential.value, { mode: 0o600 });
        output = execFileSync(
          'onecli',
          [
            'secrets',
            'create',
            '--name',
            'Codex',
            '--type',
            'openai',
            '--file',
            file,
            '--host-pattern',
            new URL(getProviderModelEndpoint(provider, credential.kind === 'api-key' ? 'api' : 'subscription'))
              .hostname,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch {
        throw new Error('Cannot save Codex credentials in the selected OneCLI vault.');
      } finally {
        if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
      }
      // New groups get only the recorded model credential; an unparsed id is matched by name at spawn.
      const id = createdSecretId(output);
      if (id) await recordProviderCredentials(path.join(root, 'data'), provider, [id]);
    },
  };
}
