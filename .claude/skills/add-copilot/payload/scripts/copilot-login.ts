import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { getCredentialStore, type GatewayCredentialTarget } from '../setup/gateways/credential-store.js';
import { upsertEnvVar } from '../setup/set-env.js';

const KEYCHAIN_SERVICE = 'copilot-cli';
const GITHUB_HOST = 'https://github.com';
export const COPILOT_GITHUB_SECRET = 'Copilot GitHub';
export const COPILOT_API_SECRET = 'Copilot API';
/** The agent provider these credentials belong to; per-agent gateways grant them to its groups. */
export const COPILOT_PROVIDER = 'copilot';
/** The one api.github.com path the pinned Copilot CLI calls with the device-login token. */
export const COPILOT_GITHUB_PATH = '/copilot_internal/user';
/** Must equal `COPILOT_GATEWAY_PLACEHOLDER` in the container provider (a test keeps them in sync). */
export const COPILOT_CREDENTIAL_PLACEHOLDER = 'nanoclaw-gateway-placeholder';
const USAGE = 'Usage: pnpm exec tsx scripts/copilot-login.ts [--login <github-login>] [--relogin]';

export interface CopilotAccount {
  readonly apiUrl: string;
  readonly plan: string;
}

export function parseCopilotAccount(body: unknown): CopilotAccount {
  const data = body as { copilot_plan?: unknown; chat_enabled?: unknown; endpoints?: { api?: unknown } };
  if (typeof data?.endpoints?.api !== 'string') {
    throw new Error('GitHub did not return a Copilot API endpoint');
  }
  const url = new URL(data.endpoints.api);
  if (url.protocol !== 'https:') {
    throw new Error(`Copilot API endpoint must be HTTPS: ${url.href}`);
  }
  if (data.chat_enabled === false) {
    throw new Error('Copilot chat is disabled for this account');
  }
  return { apiUrl: url.origin, plan: String(data.copilot_plan ?? 'unknown') };
}

// The Copilot CLI's config.json starts with `//` comment lines.
export function lastCopilotLogin(configText: string): string | undefined {
  const json = configText.replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(json) as { lastLoggedInUser?: { host?: string; login?: string } };
  const last = config.lastLoggedInUser;
  return last?.host === GITHUB_HOST ? last.login : undefined;
}

function readKeychainToken(login: string): string | undefined {
  if (process.platform !== 'darwin') {
    throw new Error('Reading the Copilot device-login token is only supported from the macOS keychain');
  }
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', `${GITHUB_HOST}:${login}:github`, '-w'],
    { encoding: 'utf8' },
  );
  const token = result.status === 0 ? result.stdout.trim() : '';
  return token || undefined;
}

function deviceLogin(): void {
  console.log('Starting Copilot device login.');
  const result = spawnSync('copilot', ['login'], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('copilot login failed');
  }
}

/** The licensed Copilot API host takes the token host-wide, which the gateway-neutral seam expresses. */
export function copilotApiTarget(apiUrl: string): GatewayCredentialTarget {
  return {
    name: COPILOT_API_SECRET,
    kind: 'api-key',
    host: new URL(apiUrl).hostname,
    proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
    provider: COPILOT_PROVIDER,
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  };
}

/**
 * api.github.com takes the token on one exact path only: the token also carries
 * the account's repo scopes, so it must not reach the rest of the host.
 */
export function copilotGitHubTarget(): GatewayCredentialTarget {
  return {
    name: COPILOT_GITHUB_SECRET,
    kind: 'api-key',
    host: 'api.github.com',
    path: COPILOT_GITHUB_PATH,
    proxyValue: COPILOT_CREDENTIAL_PLACEHOLDER,
    provider: COPILOT_PROVIDER,
    injection: { headerName: 'Authorization', valueFormat: 'token {value}' },
  };
}

async function saveCopilotTokens(apiUrl: string, token: string): Promise<void> {
  const store = await getCredentialStore();
  if (!store.connection) throw new Error('The selected gateway does not support provider credential connections.');
  if (!store.connectionPaths) throw new Error('The selected gateway cannot limit a credential to one path.');
  for (const target of [copilotGitHubTarget(), copilotApiTarget(apiUrl)]) {
    const connection = store.connection(target);
    // A plan change moves the licensed host (individual ↔ business/enterprise); follow it.
    await connection.find({ confirmHostChange: async () => true });
    await connection.save(token);
  }
}

export async function runCopilotLogin(args = process.argv.slice(2)): Promise<void> {
  const relogin = args.includes('--relogin');
  const loginFlag = args.indexOf('--login');
  if (args.includes('--help') || (loginFlag >= 0 && !args[loginFlag + 1])) {
    console.log(USAGE);
    return;
  }

  if (relogin) {
    deviceLogin();
  }
  const configPath = path.join(process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot'), 'config.json');
  const recorded = () =>
    fs.existsSync(configPath) ? lastCopilotLogin(fs.readFileSync(configPath, 'utf8')) : undefined;
  let login = loginFlag >= 0 ? args[loginFlag + 1] : recorded();
  let token = login ? readKeychainToken(login) : undefined;
  if (!token && !relogin) {
    deviceLogin();
    login = loginFlag >= 0 ? login : recorded();
    token = login ? readKeychainToken(login) : undefined;
  }
  if (!login || !token) {
    throw new Error('No Copilot device-login token found after login');
  }

  const response = await fetch(`https://api.github.com${COPILOT_GITHUB_PATH}`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GitHub rejected the Copilot token (${response.status})`);
  }
  const account = parseCopilotAccount(await response.json());

  await saveCopilotTokens(account.apiUrl, token);
  upsertEnvVar('COPILOT_API_URL', account.apiUrl);

  console.log(`Copilot connected for ${login} (${account.plan}) via ${account.apiUrl}.`);
  console.log('Select it per group: ncl groups config update --id <group-id> --provider copilot');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCopilotLogin().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
