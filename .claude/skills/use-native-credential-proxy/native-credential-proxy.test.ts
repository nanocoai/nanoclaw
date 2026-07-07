/**
 * Behavior test for the native credential proxy (host/vitest tree).
 *
 * This is the core-consumption leg: nativeCredentialEnvArgs() reads the
 * credential from `.env` through core's readEnvFile(), so this test drives the
 * real function against a real `.env` on disk (read via the real core helper)
 * and asserts the resulting `-e` injection. If core renames/relocates
 * readEnvFile or changes its parsing, this goes red.
 *
 * readEnvFile resolves `.env` relative to process.cwd(), so each case writes a
 * fake `.env` into a temp dir and chdir's into it; process.env is cleared of
 * the credential vars so the .env values are what actually flow through.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NATIVE_CREDENTIALS_FLAG,
  NATIVE_CREDENTIAL_VARS,
  nativeCredentialEnvArgs,
  nativeCredentialsEnabled,
} from './native-credential-proxy.js';

const SAVED_CWD = process.cwd();
const SAVED_ENV: Record<string, string | undefined> = {};

function writeEnv(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cred-'));
  fs.writeFileSync(path.join(dir, '.env'), contents, 'utf8');
  return dir;
}

beforeEach(() => {
  for (const key of [NATIVE_CREDENTIALS_FLAG, ...NATIVE_CREDENTIAL_VARS]) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  process.chdir(SAVED_CWD);
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('native-credential-proxy', () => {
  it('returns no args when the opt-out flag is unset', () => {
    const dir = writeEnv('ANTHROPIC_API_KEY=sk-ant-should-be-ignored\n');
    process.chdir(dir);
    expect(nativeCredentialsEnabled()).toBe(false);
    expect(nativeCredentialEnvArgs()).toEqual([]);
  });

  it('reads an API key from .env and injects it as a container -e arg', () => {
    const dir = writeEnv('ANTHROPIC_API_KEY=sk-ant-test123\n');
    process.chdir(dir);
    process.env[NATIVE_CREDENTIALS_FLAG] = 'true';

    expect(nativeCredentialEnvArgs()).toEqual(['-e', 'ANTHROPIC_API_KEY=sk-ant-test123']);
  });

  it('reads an OAuth token from .env and forwards an optional base URL', () => {
    const dir = writeEnv('CLAUDE_CODE_OAUTH_TOKEN=oauth-tok-xyz\nANTHROPIC_BASE_URL=https://gw.example/v1\n');
    process.chdir(dir);
    process.env[NATIVE_CREDENTIALS_FLAG] = 'true';

    expect(nativeCredentialEnvArgs()).toEqual([
      '-e',
      'CLAUDE_CODE_OAUTH_TOKEN=oauth-tok-xyz',
      '-e',
      'ANTHROPIC_BASE_URL=https://gw.example/v1',
    ]);
  });

  it('throws when enabled but no credential is present in .env', () => {
    const dir = writeEnv('# no credential here\nANTHROPIC_BASE_URL=https://gw.example/v1\n');
    process.chdir(dir);
    process.env[NATIVE_CREDENTIALS_FLAG] = 'true';

    expect(() => nativeCredentialEnvArgs()).toThrow(/no Anthropic credential/);
  });
});
