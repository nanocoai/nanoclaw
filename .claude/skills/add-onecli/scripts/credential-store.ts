import { createProviderCredentialConnection, oneCliSecretsRequest } from './provider-credentials.js';
import {
  createdSecretId,
  hasProviderCredential,
  readProviderCredentials,
  recordProviderCredentials,
} from '../payload/src/gateway-providers/onecli-provider-credentials.js';
import { getProviderModelEndpoint } from '../../../../src/provider-contracts/index.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';

type SecretSummary = { id?: string; name?: string; type?: string; hostPattern?: string; valueSource?: string };

function listSecrets(): SecretSummary[] {
  try {
    const parsed = JSON.parse(
      execFileSync('onecli', ['secrets', 'list', '--max', '0'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    return (Array.isArray(parsed) ? parsed : parsed.data) ?? [];
  } catch {
    throw new Error('Cannot read the selected OneCLI vault; check that OneCLI is running.');
  }
}

type SecretsRequest = ReturnType<typeof oneCliSecretsRequest>;

/**
 * The recorded secret a new login replaces: the one on the login's host, else
 * the only one. Only an inline `openai` secret, whose host and login details
 * OneCLI derives again from the new value. Read through the same management
 * connection that writes, so both act on one vault.
 */
async function replaceableSecret(
  root: string,
  provider: string,
  host: string,
  request: () => SecretsRequest,
): Promise<string | undefined> {
  const recorded = readProviderCredentials(path.join(root, 'data')).providers[provider] ?? [];
  if (!recorded.length) return undefined;
  const listed = (await request()('', 'GET')) as SecretSummary[] | { data?: SecretSummary[] };
  const mine = (Array.isArray(listed) ? listed : (listed.data ?? [])).filter(
    (s) =>
      typeof s.id === 'string' &&
      recorded.includes(s.id) &&
      s.type === 'openai' &&
      (s.valueSource === undefined || s.valueSource === 'inline'),
  );
  const sameHost = mine.filter((s) => s.hostPattern === host);
  // Two logins holding one refresh token invalidate each other, so never fill both.
  if (sameHost.length > 1) {
    throw new Error(
      `Several recorded Codex secrets use ${host} (${sameHost.map((s) => s.id).join(', ')}). Delete all but one in OneCLI, then sign in again.`,
    );
  }
  return (sameHost[0] ?? (mine.length === 1 ? mine[0] : undefined))?.id;
}

/** OneCLI files a ChatGPT login without both tokens as an API key, so a partial one must not replace a working login. */
function chatGptLogin(file: string): string {
  let tokens: { access_token?: unknown; refresh_token?: unknown } | undefined;
  const value = fs.readFileSync(file, 'utf8');
  try {
    tokens = JSON.parse(value)?.tokens;
  } catch {
    tokens = undefined;
  }
  if (typeof tokens?.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
    throw new Error('Codex login did not produce a complete ChatGPT session.');
  }
  return value;
}

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
      return hasProviderCredential(path.join(root, 'data'), provider, listSecrets());
    },
    async save(provider, credential) {
      check(provider);
      const host = new URL(getProviderModelEndpoint(provider, credential.kind === 'api-key' ? 'api' : 'subscription'))
        .hostname;
      // Signing in again replaces the value in place: groups already granted
      // the secret keep it, and no second Codex secret competes for the host.
      // Through the management API, so the value never appears in argv.
      let request: SecretsRequest | undefined;
      const connect = () => (request ??= oneCliSecretsRequest('Codex', undefined, undefined, globalThis.fetch, root));
      const existing = await replaceableSecret(root, provider, host, connect);
      if (existing) {
        const value = credential.kind === 'oauth' ? chatGptLogin(credential.file) : credential.value;
        await connect()(`/${encodeURIComponent(existing)}`, 'PATCH', { value: value.trim() });
        return;
      }
      const temporary =
        credential.kind === 'api-key' ? fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-codex-')) : undefined;
      let output: string;
      try {
        const file = credential.kind === 'oauth' ? credential.file : path.join(temporary!, 'key');
        if (credential.kind === 'api-key') fs.writeFileSync(file, credential.value, { mode: 0o600 });
        output = execFileSync(
          'onecli',
          ['secrets', 'create', '--name', 'Codex', '--type', 'openai', '--file', file, '--host-pattern', host],
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
