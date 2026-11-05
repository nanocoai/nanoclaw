/**
 * Guard for MATRIX_INSTANCES (matrix-instances.ts + matrix.ts).
 *
 * What breaks without it: a second Matrix account listed in .env never
 * registers, reads the default account's credentials, or shares its crypto
 * store with the default account.
 *
 * `.env` is read from process.cwd() at call time, so the test chdirs into a
 * temp dir carrying a crafted .env before importing the modules.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getChannelDefaults, getRegisteredChannelNames } from './channel-registry.js';

const originalCwd = process.cwd();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-instances-'));
  writeFileSync(
    join(dir, '.env'),
    [
      'MATRIX_INSTANCES=scotty,no-creds,Bad_Name',
      'MATRIX_BASE_URL=https://hs.example',
      'MATRIX_USERNAME=alfred',
      'MATRIX_PASSWORD=pw-alfred',
      'MATRIX_BOT_USERNAME=Alfred',
      'MATRIX_BASE_URL_SCOTTY=https://hs.example',
      'MATRIX_ACCESS_TOKEN_SCOTTY=tok-scotty',
      'MATRIX_USER_ID_SCOTTY=@scotty:hs.example',
      'MATRIX_BOT_USERNAME_SCOTTY=Scotty',
      'MATRIX_DEVICE_ID_SCOTTY=SCOTTYDEV',
      'MATRIX_RECOVERY_KEY_SCOTTY=rk',
      '',
    ].join('\n'),
  );
  process.chdir(dir);
  await import('./index.js');
});

afterAll(() => process.chdir(originalCwd));

describe('matrix multi-account', () => {
  it('registers a matrix-<name> key per valid name, skipping invalid ones', () => {
    const names = getRegisteredChannelNames();
    expect(names).toContain('matrix');
    expect(names).toContain('matrix-scotty');
    expect(names).toContain('matrix-no-creds');
    expect(names).not.toContain('matrix-Bad_Name');
    expect(getChannelDefaults('matrix-scotty')).toEqual(getChannelDefaults('matrix'));
  });

  it('builds the default account from unsuffixed variables', async () => {
    const { buildMatrixConfig } = await import('./matrix-instances.js');
    const c = buildMatrixConfig();
    expect(c?.auth).toMatchObject({ type: 'password', username: 'alfred' });
    expect(c?.userName).toBe('Alfred');
    expect(c?.e2ee).toBeUndefined();
    expect(c?.inviteAutoJoin).toBeDefined();
  });

  it('builds a named account from suffixed variables only, with its own crypto store', async () => {
    const { buildMatrixConfig } = await import('./matrix-instances.js');
    const c = buildMatrixConfig('scotty');
    expect(c?.auth).toMatchObject({ type: 'accessToken', accessToken: 'tok-scotty', userID: '@scotty:hs.example' });
    expect(c?.userName).toBe('Scotty');
    expect(c?.deviceID).toBe('SCOTTYDEV');
    expect(c?.e2ee?.cryptoDatabasePrefix).toBe('nanoclaw-scotty-');
  });

  it('refuses a second instance on an account that is already running', async () => {
    const { buildMatrixConfig, claimMatrixAccount } = await import('./matrix-instances.js');
    const scotty = buildMatrixConfig('scotty')!;
    const alfred = buildMatrixConfig()!;
    expect(claimMatrixAccount(alfred, 'matrix')).toBeUndefined();
    expect(claimMatrixAccount(scotty, 'matrix-scotty')).toBeUndefined();
    // same instance re-claiming (restart) is fine
    expect(claimMatrixAccount(scotty, 'matrix-scotty')).toBeUndefined();
    // another instance on scotty's account, spelled as full MXID vs localpart, is refused
    const twin = { ...scotty, auth: { type: 'password' as const, username: 'Scotty', password: 'x' } };
    twin.baseURL = scotty.baseURL + '/';
    expect(claimMatrixAccount(twin, 'matrix-twin')).toBe('matrix-scotty');
    // and a different account on the same homeserver is not
    expect(claimMatrixAccount({ ...twin, auth: { ...twin.auth, username: 'other' } }, 'matrix-other')).toBeUndefined();
  });

  it('returns null for a name without credentials', async () => {
    const { buildMatrixConfig } = await import('./matrix-instances.js');
    expect(buildMatrixConfig('no-creds')).toBeNull();
  });
});
