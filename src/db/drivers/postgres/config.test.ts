import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';

import type { PostgresDbConfig, PostgresEnvironment } from './config.js';
import { resolvePostgresConfig, selectPostgresUrl } from './config.js';

const { Client } = pg;
const tempDirs: string[] = [];

function base(overrides: Partial<PostgresDbConfig> = {}): PostgresDbConfig {
  return {
    path: 'ignored.db',
    url: 'postgres://runtime@localhost:5432/nanoclaw',
    schema: 'nanoclaw',
    statementTimeoutMs: 30_000,
    hostLock: true,
    ...overrides,
  };
}

function environment(overrides: Partial<PostgresEnvironment> = {}): PostgresEnvironment {
  return {
    url: '',
    passwordFile: '',
    migrateUrl: '',
    migratePasswordFile: '',
    schema: 'nanoclaw',
    testUrl: '',
    ...overrides,
  };
}

function passwordFile(mode = 0o600, contents = 'secret\n'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pg-config-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'password');
  fs.writeFileSync(file, contents, { mode });
  fs.chmodSync(file, mode);
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('PostgreSQL configuration', () => {
  it('selects runtime, migration, and test URLs by role', () => {
    const env = environment({
      url: 'postgres://runtime@localhost/nanoclaw',
      migrateUrl: 'postgres://owner@localhost/nanoclaw',
      testUrl: 'postgres://postgres:x@localhost/nanoclaw_test',
    });
    expect(selectPostgresUrl(env, 'host')).toBe(env.url);
    expect(selectPostgresUrl(env, 'tool')).toBe(env.url);
    expect(selectPostgresUrl(env, 'migration')).toBe(env.migrateUrl);
    expect(selectPostgresUrl(env, 'test')).toBe(env.testUrl);
  });

  it('loads runtime passwords only from a restricted file', () => {
    const resolved = resolvePostgresConfig(base({ passwordFile: passwordFile() }), { role: 'host' }, environment());
    expect(new URL(resolved.pool.connectionString!).password).toBe('secret');
    expect(resolved.pool.max).toBe(5);
  });

  it('preserves percent escapes in a file-sourced password', () => {
    const resolved = resolvePostgresConfig(
      base({ passwordFile: passwordFile(0o600, 'fo%41\n') }),
      { role: 'host' },
      environment(),
    );
    const client = new Client(resolved.pool);
    const parameters = (
      client as unknown as { connectionParameters: { user: string | undefined; password: string | undefined } }
    ).connectionParameters;
    expect(parameters.password).toBe('fo%41');
  });

  it('uses the separate owner password file for migrations', () => {
    const runtimeFile = passwordFile(0o600, 'runtime-secret\n');
    const ownerFile = passwordFile(0o600, 'owner-secret\n');
    const resolved = resolvePostgresConfig(
      base({ url: undefined }),
      { role: 'migration' },
      environment({
        url: 'postgres://runtime@localhost/nanoclaw',
        passwordFile: runtimeFile,
        migrateUrl: 'postgres://owner@localhost/nanoclaw',
        migratePasswordFile: ownerFile,
      }),
    );
    const client = new Client(resolved.pool);
    const parameters = (
      client as unknown as { connectionParameters: { user: string | undefined; password: string | undefined } }
    ).connectionParameters;
    expect(parameters.user).toBe('owner');
    expect(parameters.password).toBe('owner-secret');
  });

  it('refuses inline non-test passwords and permissive secret files', () => {
    expect(() =>
      resolvePostgresConfig(base({ url: 'postgres://runtime:inline@localhost/nanoclaw' }), { role: 'host' }, environment()),
    ).toThrow('NANOCLAW_DB_URL must not contain a password');
    expect(() =>
      resolvePostgresConfig(
        base({ url: undefined, migrateUrl: 'postgres://owner:inline@localhost/nanoclaw' }),
        { role: 'migration' },
        environment(),
      ),
    ).toThrow('NANOCLAW_DB_MIGRATE_URL must not contain a password');
    expect(() =>
      resolvePostgresConfig(base({ passwordFile: passwordFile(0o644) }), { role: 'runtime' }, environment()),
    ).toThrow('0400 or 0600');
  });

  it('refuses missing and empty password files', () => {
    expect(() =>
      resolvePostgresConfig(
        base({ passwordFile: '/definitely/missing/nanoclaw-password' }),
        { role: 'host' },
        environment(),
      ),
    ).toThrow('ENOENT');
    expect(() =>
      resolvePostgresConfig(base({ passwordFile: passwordFile(0o600, '\n') }), { role: 'runtime' }, environment()),
    ).toThrow('password file is empty');
  });

  it('allows inline test credentials and validates test database names', () => {
    expect(() =>
      resolvePostgresConfig(base({ url: 'postgres://postgres:x@localhost/production' }), { role: 'test' }, environment()),
    ).toThrow('must start with "nanoclaw_test"');
    expect(
      resolvePostgresConfig(
        base({ url: 'postgres://postgres:x@localhost/nanoclaw_test' }),
        { role: 'test' },
        environment(),
      ).role,
    ).toBe('test');
  });

  it('rejects unsafe schema names', () => {
    expect(() =>
      resolvePostgresConfig(
        base({ schema: 'nanoclaw; DROP SCHEMA public', migratePasswordFile: passwordFile() }),
        { role: 'migration' },
        environment(),
      ),
    ).toThrow('lowercase PostgreSQL identifier');
  });
});
