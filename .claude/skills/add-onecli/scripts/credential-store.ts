import { getProviderModelEndpoint } from '../../../../src/provider-contracts/index.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';

export function createCredentialStore(): ProviderCredentialStore {
  const check = (provider: string) => {
    if (provider !== 'codex') throw new Error(`OneCLI credential adapter does not support ${provider}`);
  };
  return {
    async has(provider) {
      check(provider);
      try {
        const parsed = JSON.parse(
          execFileSync('onecli', ['secrets', 'list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
        );
        return (parsed.data ?? []).some(
          (s: { name?: string; type?: string; hostPattern?: string }) =>
            /^(codex|openai)$/i.test(s.name ?? '') ||
            s.type === 'openai' ||
            (['api', 'subscription'] as const).some(
              (kind) => s.hostPattern?.toLowerCase() === new URL(getProviderModelEndpoint(provider, kind)).hostname,
            ),
        );
      } catch {
        throw new Error('Cannot read the selected OneCLI vault; check that OneCLI is running.');
      }
    },
    async save(provider, credential) {
      check(provider);
      const temporary =
        credential.kind === 'api-key' ? fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-codex-')) : undefined;
      try {
        const file = credential.kind === 'oauth' ? credential.file : path.join(temporary!, 'key');
        if (credential.kind === 'api-key') fs.writeFileSync(file, credential.value, { mode: 0o600 });
        execFileSync(
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
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
      } catch {
        throw new Error('Cannot save Codex credentials in the selected OneCLI vault.');
      } finally {
        if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
      }
    },
  };
}
