/**
 * Where the gpt-live channel's OpenAI key comes from.
 *
 * Two sources, checked in order, both read on the host only:
 *  1. `OPENAI_API_KEY` in `.env` — the plain option every channel skill uses.
 *  2. The macOS login Keychain — `.env` carries only the item's service name
 *     (`GPT_LIVE_KEYCHAIN_SERVICE`, account defaults to the login user) and
 *     the key is read at startup with the system `security` tool. The key
 *     never sits in a file NanoClaw owns, and the operator adds it with one
 *     interactive command that keeps it out of shell history.
 *
 * Nothing here logs or returns the key anywhere but to the adapter factory.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { log } from '../log.js';

export const KEYCHAIN_SERVICE_DEFAULT = 'nanoclaw-openai';

export type KeychainReader = (service: string, account: string) => string;

export interface KeySources {
  OPENAI_API_KEY?: string;
  GPT_LIVE_KEYCHAIN_SERVICE?: string;
  GPT_LIVE_KEYCHAIN_ACCOUNT?: string;
}

/** Read one generic-password item from the login Keychain. macOS only. */
export function readKeychainSecret(service: string, account: string): string {
  if (process.platform !== 'darwin') throw new Error('Keychain lookup is macOS-only');
  return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
}

/**
 * The key and where it came from, or `null` when nothing is configured or the
 * Keychain item can't be read — the factory then leaves the channel offline
 * rather than starting half-configured.
 */
export function resolveOpenAiKey(
  env: KeySources,
  read: KeychainReader = readKeychainSecret,
): { key: string; source: 'env' | 'keychain' } | null {
  if (env.OPENAI_API_KEY) return { key: env.OPENAI_API_KEY, source: 'env' };
  const service = env.GPT_LIVE_KEYCHAIN_SERVICE;
  if (!service) return null;
  const account = env.GPT_LIVE_KEYCHAIN_ACCOUNT || os.userInfo().username;
  try {
    const key = read(service, account);
    return key ? { key, source: 'keychain' } : null;
  } catch (err) {
    // `security` exits non-zero when the item is missing or the keychain is
    // locked; either way the channel must not start. The error carries no
    // secret (stderr is discarded above).
    log.warn('gpt-live: Keychain lookup failed; the channel stays offline', { service, account, err });
    return null;
  }
}
