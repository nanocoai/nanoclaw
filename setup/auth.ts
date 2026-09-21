/**
 * Step: auth — Verify or register an Anthropic credential in OneCLI.
 *
 * Modes:
 *   --check                   (default) Verify an Anthropic secret exists.
 *   --create --value <token>  Create an Anthropic secret. Errors if one
 *                             already exists unless --force is passed.
 *
 * The actual user-facing prompt (subscription vs API key, paste the token)
 * stays in the /new-setup SKILL.md. This step is just the machine side:
 * it calls `onecli secrets list` / `onecli secrets create` and emits a
 * structured status block. The token value is never logged.
 */
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

interface Args {
  mode: 'check' | 'create';
  value?: string;
  force: boolean;
}

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function parseArgs(args: string[]): Args {
  let mode: 'check' | 'create' = 'check';
  let value: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    switch (key) {
      case '--check':
        mode = 'check';
        break;
      case '--create':
        mode = 'create';
        break;
      case '--value':
        value = val;
        i++;
        break;
      case '--force':
        force = true;
        break;
    }
  }

  if (mode === 'create' && !value) {
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'missing_value_for_create',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { mode, value, force };
}

interface OnecliSecret {
  id: string;
  name: string;
  type: string;
  hostPattern: string | null;
}

function listSecrets(): OnecliSecret[] {
  const out = execFileSync('onecli', ['secrets', 'list'], {
    encoding: 'utf-8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out) as { data?: unknown };
  return Array.isArray(parsed.data) ? (parsed.data as OnecliSecret[]) : [];
}

function findAnthropicSecret(secrets: OnecliSecret[]): OnecliSecret | undefined {
  return secrets.find((s) => s.type === 'anthropic');
}

function createAnthropicSecret(value: string): void {
  // `value` is a credential — do not log it, do not echo, do not pass through a shell.
  execFileSync(
    'onecli',
    [
      'secrets',
      'create',
      '--name',
      'Anthropic',
      '--type',
      'anthropic',
      '--value',
      value,
      '--host-pattern',
      'api.anthropic.com',
    ],
    {
      env: childEnv(),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
}

export async function run(args: string[]): Promise<void> {
  const { mode, value, force } = parseArgs(args);

  let secrets: OnecliSecret[];
  try {
    secrets = listSecrets();
  } catch (err) {
    log.error('onecli secrets list failed', { err });
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'onecli_list_failed',
      HINT: 'Is OneCLI running? Run `/new-setup` from the onecli step.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const existing = findAnthropicSecret(secrets);

  if (mode === 'check') {
    emitStatus('AUTH', {
      SECRET_PRESENT: !!existing,
      ANTHROPIC_OK: !!existing,
      STATUS: existing ? 'success' : 'missing',
      ...(existing ? { SECRET_NAME: existing.name, SECRET_ID: existing.id } : {}),
      LOG: 'logs/setup.log',
    });
    return;
  }

  // mode === 'create'
  if (existing && !force) {
    emitStatus('AUTH', {
      SECRET_PRESENT: true,
      STATUS: 'skipped',
      REASON: 'anthropic_secret_already_exists',
      SECRET_NAME: existing.name,
      SECRET_ID: existing.id,
      HINT: 'Re-run with --force to replace, or delete the existing secret first.',
      LOG: 'logs/setup.log',
    });
    return;
  }

  try {
    createAnthropicSecret(value!);
  } catch (err) {
    const e = err as { stderr?: string | Buffer; status?: number };
    const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString('utf-8') ?? '');
    log.error('onecli secrets create failed', { status: e.status, stderr });
    emitStatus('AUTH', {
      STATUS: 'failed',
      ERROR: 'onecli_create_failed',
      EXIT_CODE: e.status ?? -1,
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Re-verify
  const updated = findAnthropicSecret(listSecrets());

  emitStatus('AUTH', {
    SECRET_PRESENT: !!updated,
    ANTHROPIC_OK: !!updated,
    CREATED: true,
    STATUS: updated ? 'success' : 'failed',
    ...(updated ? { SECRET_NAME: updated.name, SECRET_ID: updated.id } : {}),
    LOG: 'logs/setup.log',
  });
}
