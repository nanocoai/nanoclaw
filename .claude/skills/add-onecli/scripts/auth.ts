import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';

import {
  createdSecretId,
  hasProviderCredential,
  isSavedProviderCredential,
  recordProviderCredentials,
} from '../payload/src/gateway-providers/onecli-provider-credentials.js';
import {
  anthropicCredentialError,
  anthropicCredentialPrompt,
  pastedCredential,
} from '../../../../setup/lib/anthropic-credential.js';
import { createSecret } from './secret-input.js';

type Method = 'subscription' | 'oauth' | 'api' | 'skip';

function childEnv(): NodeJS.ProcessEnv {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  return {
    ...process.env,
    PATH: `${localBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

type SecretRow = { id?: string; type?: string; name?: string };

function listSecrets(): SecretRow[] {
  const raw = execFileSync('onecli', ['secrets', 'list', '--max', '0'], {
    encoding: 'utf8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(raw) as SecretRow[] | { data?: SecretRow[] };
  return (Array.isArray(parsed) ? parsed : parsed.data) ?? [];
}

const dataDir = () => path.join(process.cwd(), 'data');

// Connected means Claude groups will be granted a recorded credential.
async function hasAnthropicSecret(): Promise<boolean> {
  let secrets: SecretRow[];
  try {
    secrets = listSecrets();
  } catch {
    return false;
  }
  return hasProviderCredential(dataDir(), 'claude', secrets);
}

// New groups get only the recorded model credential, so record what was saved:
// the created id, or the one Claude secret that appeared since `before`.
async function recordClaudeSecret(id: string | null, before = new Set<string>()): Promise<void> {
  const ids = id
    ? [id]
    : listSecrets().flatMap((s) => (s.id && !before.has(s.id) && isSavedProviderCredential('claude', s) ? [s.id] : []));
  if (ids.length > 1) {
    throw new Error(
      `more than one Anthropic secret appeared during sign-in (${ids.join(', ')}), perhaps from another setup on this gateway: run setup again`,
    );
  }
  if (ids.length) await recordProviderCredentials(dataDir(), 'claude', ids);
}

async function saveSecret(value: string, baseUrl?: string, before?: Set<string>): Promise<void> {
  const args = ['--name', 'Anthropic'];
  if (baseUrl) {
    args.push(
      '--type',
      'generic',
      '--host-pattern',
      new URL(baseUrl).hostname,
      '--header-name',
      'Authorization',
      '--value-format',
      'Bearer {value}',
    );
  } else {
    args.push('--type', 'anthropic', '--host-pattern', 'api.anthropic.com');
  }
  await recordClaudeSecret(createdSecretId(createSecret(args, value, childEnv())), before);
}

// The script only captures the token, into a private file: saving it here
// keeps a failed save as redacted as a pasted token's.
function capturedSubscriptionToken(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-claude-token-'));
  const output = path.join(dir, 'token');
  try {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'register-claude-token.sh');
    const result = spawnSync('bash', [script, output], { env: childEnv(), stdio: 'inherit' });
    const token = result.status === 0 && fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim() : '';
    if (!token) throw new Error('Claude subscription sign-in failed');
    return token;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function saveEnv(key: string, value: string): void {
  const file = path.join(process.cwd(), '.env');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  fs.writeFileSync(
    file,
    pattern.test(current)
      ? current.replace(pattern, line)
      : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`,
    { mode: 0o600 },
  );
}

async function migrateLegacyEnvSecret(): Promise<boolean> {
  const file = path.join(process.cwd(), '.env');
  if (!fs.existsSync(file)) return false;
  const current = fs.readFileSync(file, 'utf8');
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];
  const found = keys.flatMap((key) => {
    const value = current.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim();
    return value ? [{ key, value }] : [];
  });
  if (found.length === 0) return false;
  if (found.length > 1) {
    throw new Error(
      `Multiple Anthropic credentials exist in .env (${found.map(({ key }) => key).join(', ')}); keep one and retry`,
    );
  }
  await saveSecret(found[0].value);
  const next = current
    .split('\n')
    .filter((line) => !line.startsWith(`${found[0].key}=`))
    .join('\n');
  fs.writeFileSync(file, next, { mode: 0o600 });
  p.log.success('Migrated the Anthropic credential from .env into OneCLI.');
  return true;
}

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error('Authentication cancelled');
  return value as T;
}

export async function run(): Promise<void> {
  const provider = process.argv[2] || 'claude';
  if (provider !== 'claude') {
    await import('../../../../setup/providers/index.js');
    const { getSetupProvider } = await import('../../../../setup/providers/registry.js');
    const entry = getSetupProvider(provider);
    if (!entry?.runAuth) throw new Error(`No authentication flow installed for ${provider}`);
    await entry.runAuth();
    return;
  }
  const customUrl = process.env.NANOCLAW_ANTHROPIC_BASE_URL?.trim();
  const customToken = process.env.NANOCLAW_ANTHROPIC_AUTH_TOKEN?.trim();
  if (customUrl && customToken) {
    await saveSecret(customToken, customUrl);
    saveEnv('ANTHROPIC_BASE_URL', customUrl);
    p.log.success('Claude endpoint connected.');
    return;
  }

  if (await migrateLegacyEnvSecret()) return;

  if (await hasAnthropicSecret()) {
    p.log.success('Claude account is already connected.');
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
  if (method === 'subscription') {
    // Without a parsed id, record only the Claude secret this save added.
    const before = new Set(listSecrets().flatMap((s) => (s.id ? [s.id] : [])));
    await saveSecret(capturedSubscriptionToken(), undefined, before);
    p.log.success('Claude account connected.');
    return;
  }

  const token = pastedCredential(
    answer<string>(
      await p.password({
        message: anthropicCredentialPrompt(method),
        clearOnError: true,
        validate: (raw) => anthropicCredentialError(method, raw),
      }),
    ),
  );
  await saveSecret(token);
  p.log.success('Claude account connected.');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
