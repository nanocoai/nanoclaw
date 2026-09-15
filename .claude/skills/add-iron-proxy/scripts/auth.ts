import { getProviderModelEndpoint } from '../../../../src/provider-contracts/index.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as p from '@clack/prompts';

import { controlPaths, controlRequest, grantSecret, IronControlRequestError } from './control.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';
import { configureCredential, statePaths } from './setup.js';
import { assertCredentialIsolation, ironHeaderName } from './credential-isolation.js';

type Method = 'subscription' | 'oauth' | 'api' | 'skip';

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error('Authentication cancelled');
  return value as T;
}

export async function existingCredential(root = process.cwd()): Promise<boolean> {
  if (fs.existsSync(controlPaths(root).registration)) {
    let credential;
    try {
      credential = await controlRequest(
        root,
        `static_secrets/lookup/${encodeURIComponent(getInstallSlug(root))}/nanoclaw-model`,
      );
    } catch (error) {
      if (error instanceof IronControlRequestError && error.status === 404) return false;
      throw error; // A control outage is not a missing login.
    }
    if (
      Object.keys(credential.inject_config ?? {}).length ||
      credential.replace_config?.proxy_value !== 'gateway-managed' ||
      credential.replace_config?.require !== false ||
      credential.replace_config?.match_headers?.some((h: string) => h !== ironHeaderName(h))
    )
      return false;
    for (const rule of credential.rules ?? [])
      await assertCredentialIsolation(root, {
        host: rule.host,
        headers: ['Authorization', 'x-api-key'],
        proxyValue: 'gateway-managed',
        ownedForeignIds: ['nanoclaw-model'],
      });
    // The auth mode is stored with the secret, so a retry after a failed grant
    // can finish without asking the user to authorize again.
    const mode = /^NanoClaw model \((ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)\)$/.exec(
      credential.name ?? '',
    )?.[1];
    await grantSecret('static', credential.id, root);
    if (mode) upsertEnvVar('NANOCLAW_IRON_PROXY_AUTH_ENV', mode, root);
    return true;
  }
  const file = statePaths(root).secretFile;
  if (!fs.existsSync(file)) return false;
  const value = fs.readFileSync(file, 'utf8');
  return !!value && value !== 'not-configured';
}

export function customEndpoint(env: NodeJS.ProcessEnv = process.env): {
  secret: string;
  authEnv: string;
  modelHost: string;
  baseUrl: string;
} | null {
  const baseUrl = env.NANOCLAW_ANTHROPIC_BASE_URL?.trim();
  const secret = env.NANOCLAW_ANTHROPIC_AUTH_TOKEN?.trim();
  if (!baseUrl || !secret) return null;
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const local = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Custom Claude endpoint must use HTTPS unless it is local');
  }
  if (local) url.hostname = 'host.docker.internal';
  return {
    secret,
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    modelHost: url.hostname,
    baseUrl: url.toString().replace(/\/$/, ''),
  };
}

function capturedSubscriptionToken(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-iron-proxy-auth-'));
  const output = path.join(dir, 'token');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capture-claude-token.sh');
  try {
    const result = spawnSync('bash', [script, output], { stdio: 'inherit' });
    if (result.status !== 0 || !fs.existsSync(output)) throw new Error('Claude subscription sign-in failed');
    const token = fs.readFileSync(output, 'utf8').trim();
    if (!token.startsWith('sk-ant-oat')) throw new Error('Claude subscription sign-in returned an invalid token');
    return token;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function run(agentProvider = process.argv[2] || 'claude', root = process.cwd()): Promise<void> {
  if (agentProvider !== 'claude') {
    await import('../../../../setup/providers/index.js');
    const { getSetupProvider } = await import('../../../../setup/providers/registry.js');
    const entry = getSetupProvider(agentProvider);
    if (!entry?.runAuth) throw new Error(`No authentication flow installed for ${agentProvider}`);
    await entry.runAuth();
    return;
  }
  const custom = customEndpoint();
  if (custom) {
    await configureCredential(custom, root);
    p.log.success('Claude endpoint connected through Iron Proxy.');
    return;
  }
  const suppliedApiKey = (process.env.NANOCLAW_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)?.trim();
  if (suppliedApiKey) {
    await configureCredential(
      {
        secret: suppliedApiKey,
        authEnv: 'ANTHROPIC_API_KEY',
        modelHost: new URL(getProviderModelEndpoint('claude', 'api')).hostname,
      },
      root,
    );
    p.log.success('Claude API connected through Iron Proxy.');
    return;
  }
  if (await existingCredential(root)) {
    p.log.success('Claude account is already connected through Iron Proxy.');
    return;
  }

  const method = answer<Method>(
    await p.select({
      message: 'How would you like to connect to Claude?',
      options: [
        {
          value: 'subscription',
          label: 'Claude subscription',
          hint: 'recommended for Pro or Max',
        },
        { value: 'oauth', label: 'Paste an OAuth token' },
        { value: 'api', label: 'Paste an Anthropic API key' },
        { value: 'skip', label: 'Skip for now' },
      ],
    }),
  );
  if (method === 'skip') {
    p.log.warn('Claude is not connected. Run setup again before starting an agent.');
    return;
  }
  const secret =
    method === 'subscription'
      ? capturedSubscriptionToken()
      : answer<string>(
          await p.password({
            message: method === 'oauth' ? 'Paste your OAuth token' : 'Paste your API key',
            clearOnError: true,
            validate: (raw) => {
              const value = (raw ?? '').replace(/\s+/g, '');
              const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';
              return value.startsWith(prefix) ? undefined : `Must start with ${prefix}`;
            },
          }),
        ).replace(/\s+/g, '');
  await configureCredential(
    {
      secret,
      authEnv: method === 'api' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN',
      modelHost: new URL(getProviderModelEndpoint('claude', 'api')).hostname,
    },
    root,
  );
  p.log.success('Claude account connected through Iron Proxy.');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
