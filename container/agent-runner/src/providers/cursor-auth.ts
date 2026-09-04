/**
 * Host-side Cursor SDK login helper.
 *
 * This file lives in the agent-runner package so Bun can resolve @cursor/sdk
 * without adding it to the host pnpm tree. It mints an expiring user API key
 * with Cursor.auth.login({ store: null }) and writes the key directly to a
 * caller-owned, mode-0600 file. The credential is never printed or placed in
 * argv; setup hands that file to `onecli secrets create --file`.
 */
import fs from 'fs';

import { Cursor, type SdkLoginOptions, type SdkLoginResult } from '@cursor/sdk';

import { TIMEZONE, formatLocalTime } from '../timezone.js';

type Login = (options?: SdkLoginOptions) => Promise<SdkLoginResult>;

interface LoginHelperOptions {
  outputPath: string;
  openBrowser: boolean;
  login?: Login;
  onLoginUrl?: (url: string) => void;
}

export async function mintCursorApiKey({
  outputPath,
  openBrowser,
  login = Cursor.auth.login,
  onLoginUrl = (url) => console.error(`Open this URL to connect Cursor:\n${url}`),
}: LoginHelperOptions): Promise<{ email?: string; apiKeyExpiresAtMs: number }> {
  const result = await login({
    store: null,
    openBrowser,
    onLoginUrl,
    apiKeyName: 'NanoClaw',
  });
  if (typeof result.apiKey !== 'string' || result.apiKey.length === 0) {
    throw new Error('Cursor login returned an empty API key');
  }

  fs.writeFileSync(outputPath, result.apiKey, {
    encoding: 'utf-8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.chmodSync(outputPath, 0o600);

  return {
    email: result.email,
    apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
  };
}

/** Operator-facing login summary. Never includes the key. */
export function formatMintedKeyMessage(result: { email?: string; apiKeyExpiresAtMs: number }): string {
  const identity = result.email ? ` as ${result.email}` : '';
  const expiry = formatLocalTime(new Date(result.apiKeyExpiresAtMs).toISOString(), TIMEZONE);
  return `Cursor account connected${identity}; the minted key was handed to the local vault. Expires ${expiry}.`;
}

export function parseCursorAuthArgs(argv: string[]): { outputPath: string; openBrowser: boolean } {
  const outputIndex = argv.indexOf('--output');
  const outputPath = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (!outputPath) {
    throw new Error('Usage: bun cursor-auth.ts --output <mode-0600-path> [--no-browser]');
  }
  return {
    outputPath,
    openBrowser: !argv.includes('--no-browser'),
  };
}

if (import.meta.main) {
  try {
    const options = parseCursorAuthArgs(process.argv.slice(2));
    const result = await mintCursorApiKey(options);
    console.log(formatMintedKeyMessage(result));
  } catch {
    // Keep this deliberately generic: SDK/filesystem errors must never echo a
    // credential into setup's inherited terminal or logs.
    console.error('Cursor sign-in failed before the credential reached the vault.');
    process.exitCode = 1;
  }
}
