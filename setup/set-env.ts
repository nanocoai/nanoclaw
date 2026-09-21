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
import { randomUUID } from 'node:crypto';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

/**
 * Upsert a `KEY=VALUE` line into the project's `.env`, returning whether the
 * key already existed. The canonical writer for new `.env` edits (legacy setup
 * steps still write directly) so flows don't invent grep/sed pipelines (which
 * can't be allowlisted tightly).
 */
export function upsertEnvVar(key: string, value: string): { existed: boolean } {
  return { existed: upsertEnvVars({ [key]: value }).has(key) };
}

/** Commit related settings together, removing every assignment the reader accepts.
 * A failed write or rename leaves the previous configuration intact. */
export function upsertEnvVars(values: Record<string, string>): Set<string> {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid env key: ${key} (must be UPPER_SNAKE_CASE)`);
    if (/[\r\n\0]/.test(value)) throw new Error(`Invalid multiline env value for ${key}`);
  }
  const namedFile = path.join(process.cwd(), '.env');
  const exists = fs.existsSync(namedFile);
  // Keep an operator's .env symlink; replace its target, in the same directory.
  const envFile = exists ? fs.realpathSync(namedFile) : namedFile;
  const content = exists ? fs.readFileSync(envFile, 'utf8') : '';
  const existed = new Set<string>();
  const lines = content.split(/(?<=\n)/).map((line) => {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    if (trimmed.startsWith('#') || eq < 0 || !Object.hasOwn(values, key)) return line;
    if (existed.has(key)) return '';
    existed.add(key);
    return `${key}=${values[key]}\n`;
  });
  let next = lines.join('');
  if (next && !next.endsWith('\n')) next += '\n';
  next += Object.entries(values)
    .filter(([key]) => !existed.has(key))
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  const temporary = `${envFile}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, next);
    if (exists) fs.fchmodSync(fd, fs.statSync(envFile).mode & 0o777);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, envFile);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
  return existed;
}

/**
 * Remove a key's line from `.env` entirely, returning whether it was there.
 *
 * Distinct from writing an empty or `false` value: for keys where setup tells
 * "unset" and "answered no" apart, only removal restores the unanswered state.
 */
export function removeEnvVar(key: string): { existed: boolean } {
  const envFile = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envFile)) return { existed: false };
  const content = fs.readFileSync(envFile, 'utf-8');
  const lineRegex = new RegExp(`^${key}=.*\\n?`, 'm');
  if (!lineRegex.test(content)) return { existed: false };
  fs.writeFileSync(envFile, content.replace(lineRegex, ''));
  return { existed: true };
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
