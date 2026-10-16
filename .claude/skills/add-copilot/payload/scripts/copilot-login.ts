import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { upsertEnvVar } from '../setup/set-env.js';
import { readEnvFile } from '../src/env.js';

export const INDIVIDUAL_COPILOT_API_HOST = 'api.individual.githubcopilot.com';
const KEYCHAIN_SERVICE = 'copilot-cli';
const GITHUB_HOST = 'https://github.com';
export const COPILOT_INTERNAL_SECRET = 'Copilot GitHub (copilot_internal)';
export const COPILOT_API_SECRET = 'Copilot API';
export const COPILOT_BLOCK_RULE = 'Block Copilot individual endpoint';
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

function onecli<T>(args: string[]): T {
  return JSON.parse(execFileSync('onecli', args, { encoding: 'utf8' })) as T;
}

function listNamed(kind: 'secrets' | 'rules'): Array<{ id: string; name: string }> {
  const result = onecli<Array<{ id: string; name: string }> | { data: Array<{ id: string; name: string }> }>([
    kind,
    'list',
    '--fields',
    'id,name',
  ]);
  return Array.isArray(result) ? result : result.data;
}

// Create before deleting so a failed create leaves the previous secret working.
function replaceSecret(name: string, tokenFile: string, args: string[]): void {
  const previous = listNamed('secrets').filter((secret) => secret.name === name);
  onecli(['secrets', 'create', '--name', name, '--type', 'generic', '--file', tokenFile, ...args]);
  for (const secret of previous) {
    onecli(['secrets', 'delete', '--id', secret.id]);
  }
}

export async function runCopilotLogin(args = process.argv.slice(2)): Promise<void> {
  const relogin = args.includes('--relogin');
  const loginFlag = args.indexOf('--login');
  if (args.includes('--help') || (loginFlag >= 0 && !args[loginFlag + 1])) {
    console.log(USAGE);
    return;
  }

  const gateway =
    process.env.NANOCLAW_GATEWAY_PROVIDER ?? readEnvFile(['NANOCLAW_GATEWAY_PROVIDER']).NANOCLAW_GATEWAY_PROVIDER;
  if (gateway !== 'onecli') {
    throw new Error(`Copilot gateway login supports OneCLI only (selected: ${gateway ?? 'none'})`);
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

  const response = await fetch('https://api.github.com/copilot_internal/user', {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`GitHub rejected the Copilot token (${response.status})`);
  }
  const account = parseCopilotAccount(await response.json());

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-login-'));
  const tokenFile = path.join(dir, 'token');
  try {
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    // The token also carries repo scopes, so api.github.com injection stays path-scoped.
    replaceSecret(COPILOT_INTERNAL_SECRET, tokenFile, [
      '--host-pattern',
      'api.github.com',
      '--path-pattern',
      '/copilot_internal/*',
      '--header-name',
      'Authorization',
      '--value-format',
      'token {value}',
    ]);
    replaceSecret(COPILOT_API_SECRET, tokenFile, [
      '--host-pattern',
      new URL(account.apiUrl).hostname,
      '--header-name',
      'Authorization',
      '--value-format',
      'Bearer {value}',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const individual = new URL(account.apiUrl).hostname === INDIVIDUAL_COPILOT_API_HOST;
  const blockRules = listNamed('rules').filter((rule) => rule.name === COPILOT_BLOCK_RULE);
  if (individual) {
    for (const rule of blockRules) {
      onecli(['rules', 'delete', '--id', rule.id]);
    }
  } else if (blockRules.length === 0) {
    onecli([
      'rules',
      'create',
      '--name',
      COPILOT_BLOCK_RULE,
      '--host-pattern',
      INDIVIDUAL_COPILOT_API_HOST,
      '--action',
      'block',
      '--enabled',
    ]);
  }
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
