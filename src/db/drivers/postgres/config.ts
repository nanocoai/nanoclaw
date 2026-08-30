import fs from 'node:fs';
import type { PoolConfig } from 'pg';

import { readEnvFile } from '../../../env.js';
import type { DbConfig, DbInitOptions, DbRole } from '../../driver.js';

const SAFE_SCHEMA = /^[a-z_][a-z0-9_]*$/;
const POSTGRES_ENV_KEYS = [
  'NANOCLAW_DB_URL',
  'NANOCLAW_DB_PASSWORD_FILE',
  'NANOCLAW_DB_MIGRATE_URL',
  'NANOCLAW_DB_MIGRATE_PASSWORD_FILE',
  'NANOCLAW_DB_SCHEMA',
  'NANOCLAW_TEST_DB_URL',
] as const;

export interface PostgresEnvironment {
  url: string;
  passwordFile: string;
  migrateUrl: string;
  migratePasswordFile: string;
  schema: string;
  testUrl: string;
}

/** Backend-private overrides used by focused driver tests. */
export interface PostgresDbConfig extends DbConfig {
  migrateUrl?: string;
  schema?: string;
  passwordFile?: string;
  migratePasswordFile?: string;
  statementTimeoutMs?: number;
  hostLock?: boolean;
}

function configuredValue(file: Record<string, string>, key: (typeof POSTGRES_ENV_KEYS)[number]): string {
  return process.env[key] || file[key] || '';
}

export function readPostgresEnvironment(): PostgresEnvironment {
  const file = readEnvFile([...POSTGRES_ENV_KEYS]);
  return {
    url: configuredValue(file, 'NANOCLAW_DB_URL'),
    passwordFile: configuredValue(file, 'NANOCLAW_DB_PASSWORD_FILE'),
    migrateUrl: configuredValue(file, 'NANOCLAW_DB_MIGRATE_URL'),
    migratePasswordFile: configuredValue(file, 'NANOCLAW_DB_MIGRATE_PASSWORD_FILE'),
    schema: configuredValue(file, 'NANOCLAW_DB_SCHEMA') || 'nanoclaw',
    testUrl: configuredValue(file, 'NANOCLAW_TEST_DB_URL'),
  };
}

export function selectPostgresUrl(environment: PostgresEnvironment, role: DbRole): string {
  if (role === 'test') return environment.testUrl;
  if (role === 'migration') return environment.migrateUrl || environment.url;
  return environment.url;
}

function readPasswordFile(filePath: string, variable: string): string {
  if (!filePath) throw new Error(`${variable} is required when the PostgreSQL URL has no password`);
  const stat = fs.statSync(filePath);
  const mode = stat.mode & 0o777;
  if (mode !== 0o400 && mode !== 0o600) {
    throw new Error(
      `PostgreSQL password file must have mode 0400 or 0600 (found ${mode.toString(8).padStart(4, '0')})`,
    );
  }
  const password = fs.readFileSync(filePath, 'utf8').trim();
  if (!password) throw new Error('PostgreSQL password file is empty');
  return password;
}

function testSchema(): string {
  const worker = (process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID || '0')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  return `nc_test_${process.pid}_${worker}`;
}

export interface ResolvedPostgresConfig {
  pool: PoolConfig;
  schema: string;
  statementTimeoutMs: number;
  role: DbInitOptions['role'];
  hostLock: boolean;
  readonly: boolean;
}

export function resolvePostgresConfig(
  config: PostgresDbConfig,
  options: DbInitOptions,
  environment: PostgresEnvironment = readPostgresEnvironment(),
): ResolvedPostgresConfig {
  const connectionString =
    options.role === 'migration'
      ? config.migrateUrl || config.url || environment.migrateUrl || environment.url
      : config.url || selectPostgresUrl(environment, options.role);
  if (!connectionString) throw new Error('PostgreSQL central DB URL is missing');
  const parsed = new URL(connectionString);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('Central DB URL must use postgres:// or postgresql://');
  }

  const schema = config.schema || (options.role === 'test' ? testSchema() : environment.schema);
  if (!SAFE_SCHEMA.test(schema)) {
    throw new Error('NANOCLAW_DB_SCHEMA must be a lowercase PostgreSQL identifier');
  }

  if (options.role === 'test') {
    const database = parsed.pathname.slice(1);
    if (!database.startsWith('nanoclaw_test')) {
      throw new Error('NANOCLAW_TEST_DB_URL database name must start with "nanoclaw_test"');
    }
  }

  if (options.role !== 'test' && parsed.password) {
    const variable = options.role === 'migration' ? 'NANOCLAW_DB_MIGRATE_URL' : 'NANOCLAW_DB_URL';
    throw new Error(`${variable} must not contain a password; use a restricted password file`);
  }
  if (!parsed.password) {
    const migration = options.role === 'migration';
    const filePath = migration
      ? config.migratePasswordFile || environment.migratePasswordFile
      : config.passwordFile || environment.passwordFile;
    const variable = migration ? 'NANOCLAW_DB_MIGRATE_PASSWORD_FILE' : 'NANOCLAW_DB_PASSWORD_FILE';
    // WHATWG leaves percent signs in the password setter escaped as %25. Double
    // encoding here makes pg-connection-string decode exactly once, preserving
    // literal password text such as fo%41.
    parsed.password = encodeURIComponent(readPasswordFile(filePath, variable));
  }

  return {
    pool: {
      connectionString: parsed.toString(),
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      application_name: `nanoclaw-${options.role}`,
    },
    schema,
    statementTimeoutMs: config.statementTimeoutMs ?? 30_000,
    role: options.role,
    hostLock: config.hostLock ?? true,
    readonly: options.readonly ?? false,
  };
}
