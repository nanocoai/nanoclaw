import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';

type Method = 'subscription' | 'oauth' | 'api' | 'skip';

function childEnv(): NodeJS.ProcessEnv {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  return {
    ...process.env,
    PATH: `${localBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

function hasAnthropicSecret(): boolean {
  try {
    const raw = execFileSync('onecli', ['secrets', 'list'], {
      encoding: 'utf8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const data = (JSON.parse(raw) as { data?: Array<{ type?: string; name?: string }> }).data ?? [];
    return data.some((secret) => secret.type === 'anthropic' || /anthropic/i.test(secret.name ?? ''));
  } catch {
    return false;
  }
}

function saveSecret(value: string, baseUrl?: string): void {
  const args = ['secrets', 'create', '--name', 'Anthropic'];
  if (baseUrl) {
    args.push(
      '--type',
      'generic',
      '--value',
      value,
      '--host-pattern',
      new URL(baseUrl).hostname,
      '--header-name',
      'Authorization',
      '--value-format',
      'Bearer {value}',
    );
  } else {
    args.push('--type', 'anthropic', '--value', value, '--host-pattern', 'api.anthropic.com');
  }
  execFileSync('onecli', args, {
    env: childEnv(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
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

function migrateLegacyEnvSecret(): boolean {
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
  saveSecret(found[0].value);
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
    saveSecret(customToken, customUrl);
    saveEnv('ANTHROPIC_BASE_URL', customUrl);
    p.log.success('Claude endpoint connected.');
    return;
  }

  if (migrateLegacyEnvSecret()) return;

  if (hasAnthropicSecret()) {
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
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'register-claude-token.sh');
    const result = spawnSync('bash', [script], {
      env: childEnv(),
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error('Claude subscription sign-in failed');
    return;
  }

  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';
  const token = answer<string>(
    await p.password({
      message: method === 'oauth' ? 'Paste your OAuth token' : 'Paste your API key',
      clearOnError: true,
      validate: (raw) => {
        const value = (raw ?? '').replace(/\s+/g, '');
        if (!value) return 'Required';
        if (!value.startsWith(prefix)) return `Must start with ${prefix}`;
        return undefined;
      },
    }),
  ).replace(/\s+/g, '');
  saveSecret(token);
  p.log.success('Claude account connected.');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
