/**
 * Step: set-env — Write or update a KEY=VALUE in .env.
 *
 * Usage:
 *   pnpm exec tsx setup/index.ts --step set-env -- \
 *     --key TELEGRAM_BOT_TOKEN --value "<token>"
 *
 * Exists so channel-install flows don't have to invent grep/sed/rm pipelines
 * (which can't be allowlisted tightly — sed can read any file, and each
 * segment of an && chain is matched separately).
 *
 * Logs the key but never the value.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

/**
 * Upsert a `KEY=VALUE` line into the project's `.env`, returning whether the
 * key already existed. The canonical writer for new `.env` edits (legacy setup
 * steps still write directly) so flows don't invent grep/sed pipelines (which
 * can't be allowlisted tightly).
 */
export function upsertEnvVar(key: string, value: string): { existed: boolean } {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid env key: ${key} (must be UPPER_SNAKE_CASE)`);
  }
  const envFile = path.join(process.cwd(), '.env');
  let content = '';
  if (fs.existsSync(envFile)) {
    content = fs.readFileSync(envFile, 'utf-8');
  }
  const lineRegex = new RegExp(`^${key}=.*$`, 'm');
  const existed = lineRegex.test(content);
  const newLine = `${key}=${value}`;
  if (existed) {
    content = content.replace(lineRegex, newLine);
  } else {
    const sep = content && !content.endsWith('\n') ? '\n' : '';
    content = content + sep + newLine + '\n';
  }
  fs.writeFileSync(envFile, content);
  return { existed };
}

export async function run(args: string[]): Promise<void> {
  const keyIdx = args.indexOf('--key');
  const valueIdx = args.indexOf('--value');

  if (keyIdx === -1 || !args[keyIdx + 1]) {
    throw new Error('--key <KEY> is required');
  }
  if (valueIdx === -1 || args[valueIdx + 1] === undefined) {
    throw new Error('--value <VALUE> is required');
  }

  const key = args[keyIdx + 1];
  const value = args[valueIdx + 1];

  const { existed } = upsertEnvVar(key, value);
  log.info('Updated .env', { key, existed });

  emitStatus('SET_ENV', {
    KEY: key,
    EXISTED: existed,
    STATUS: 'success',
  });
}
