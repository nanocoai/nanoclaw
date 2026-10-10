import { createIronCredentialConnection, ironModelEndpoint } from './provider-credentials.js';
import { getProviderModelEndpoint } from '../../../../src/provider-contracts/index.js';
import fs from 'node:fs';
import path from 'node:path';

import type { ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { controlPaths, controlRequest, grantSecret } from './control.js';
import { run, statePaths } from './setup.js';
import { assertCredentialIsolation, ironHeaderName } from './credential-isolation.js';

/**
 * Iron Control seeds a broker credential with only the refresh token and mints
 * its first access token on a once-a-minute poll. Until then the proxy injects
 * no Authorization header and the first agent turn fails with 401, so setup
 * waits for the broker to report a live token before it declares success.
 */
export async function waitForBrokerToken(
  root: string,
  brokerId: string,
  { timeoutMs = 150_000, intervalMs = 2_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const broker = await controlRequest(root, `broker_credentials/${brokerId}`);
    if (broker.dead)
      throw new Error(
        'Iron Control could not refresh the Codex session; check the broker credential in the console and log in again.',
      );
    if (broker.status === 'live') return;
    if (Date.now() >= deadline)
      throw new Error(
        'Iron Control has not minted a Codex access token yet; check the broker credential in the console and retry.',
      );
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function createCredentialStore(root = process.cwd()): ProviderCredentialStore {
  const namespace = getInstallSlug(root);
  const metadata = path.join(controlPaths(root).directory, 'codex.json');
  const check = (provider: string) => {
    if (provider !== 'codex') throw new Error(`Iron credential adapter does not support ${provider}`);
    if (!fs.existsSync(controlPaths(root).registration))
      throw new Error('Install Iron Control before connecting Codex.');
  };
  const isolate = (host: string) =>
    assertCredentialIsolation(root, {
      host,
      headers: ['Authorization', 'ChatGPT-Account-Id'],
      proxyValue: 'nc-codex-token-v1',
      ownedForeignIds: ['codex-api', 'codex-chatgpt', 'codex-account'],
    });
  const saveSecret = async (id: string, source: unknown, host: string, header: string) => {
    const secret = await controlRequest(root, `static_secrets/${id}`, 'PUT', {
      namespace,
      name: `Codex ${header}`,
      source,
      inject_config: {},
      replace_config: { proxy_value: 'nc-codex-token-v1', match_headers: [ironHeaderName(header)], require: false },
      rules: [{ host, http_methods: ['*'] }],
    });
    await grantSecret('static', secret.id, root);
    return secret.id;
  };
  return {
    modelEndpoint: (url) => ironModelEndpoint(url, root),
    connection: (target) => createIronCredentialConnection(target, root),
    async has(provider) {
      check(provider);
      if (!fs.existsSync(metadata)) return false;
      const state = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      for (const id of state.secretIds) {
        const secret = await controlRequest(root, `static_secrets/${id}`);
        // Old host-wide injection needs reconnection; values cannot be read back.
        if (
          Object.keys(secret.inject_config ?? {}).length ||
          secret.replace_config?.proxy_value !== 'nc-codex-token-v1' ||
          secret.replace_config?.require !== false ||
          secret.replace_config?.match_headers?.some((h: string) => h !== ironHeaderName(h))
        )
          return false;
        for (const rule of secret.rules ?? []) await isolate(rule.host);
      }
      if (state.brokerId) {
        const broker = await controlRequest(root, `broker_credentials/${state.brokerId}`);
        if (broker.dead) return false;
      }
      return true;
    },
    async save(provider, credential) {
      check(provider);
      let mode: 'api' | 'chatgpt', host: string, brokerId: string | undefined;
      const secretIds: string[] = [];
      if (credential.kind === 'api-key') {
        mode = 'api';
        host = new URL(getProviderModelEndpoint(provider, 'api')).hostname;
        await isolate(host);
        secretIds.push(
          await saveSecret(
            'codex-api',
            { source_type: 'control_plane', secret: credential.value, config: {} },
            host,
            'Authorization',
          ),
        );
      } else {
        mode = 'chatgpt';
        host = new URL(getProviderModelEndpoint(provider, 'subscription')).hostname;
        await isolate(host);
        const auth = JSON.parse(fs.readFileSync(credential.file, 'utf8'));
        const tokens = auth.tokens;
        if (!tokens?.refresh_token || !tokens?.account_id || !tokens?.id_token)
          throw new Error('Codex login did not produce a complete ChatGPT session.');
        const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
        const clientId = typeof claims.aud === 'string' ? claims.aud : claims.aud?.[0];
        if (!clientId) throw new Error('Codex login did not identify its OAuth client.');
        const broker = await controlRequest(root, 'broker_credentials/codex', 'PUT', {
          namespace,
          name: 'Codex ChatGPT',
          token_endpoint: getProviderModelEndpoint(provider, 'token'),
          client_id: clientId,
          refresh_token: tokens.refresh_token,
        });
        brokerId = broker.id;
        await waitForBrokerToken(root, broker.id);
        secretIds.push(
          await saveSecret(
            'codex-chatgpt',
            { source_type: 'token_broker', config: { credential_id: broker.id } },
            host,
            'Authorization',
          ),
        );
        secretIds.push(
          await saveSecret(
            'codex-account',
            { source_type: 'control_plane', secret: tokens.account_id, config: {} },
            host,
            'ChatGPT-Account-Id',
          ),
        );
      }
      const paths = statePaths(root);
      const allowed = JSON.parse(fs.readFileSync(paths.allowedHosts, 'utf8')) as string[];
      fs.writeFileSync(paths.allowedHosts, JSON.stringify([...new Set([...allowed, host])]), { mode: 0o600 });
      await run([], root);
      // Mark setup complete only after the proxy has accepted its new configuration.
      // Record only non-secret IDs and mode. Iron owns all token refreshes.
      fs.writeFileSync(metadata, JSON.stringify({ mode, brokerId, secretIds }) + '\n', { mode: 0o600 });
    },
  };
}
