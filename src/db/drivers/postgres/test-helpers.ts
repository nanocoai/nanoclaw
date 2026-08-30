import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pg from 'pg';

const { Client } = pg;
const KEYS = [
  'NANOCLAW_DB_URL',
  'NANOCLAW_DB_PASSWORD_FILE',
  'NANOCLAW_DB_MIGRATE_URL',
  'NANOCLAW_DB_MIGRATE_PASSWORD_FILE',
  'NANOCLAW_DB_SCHEMA',
] as const;

export interface PostgresTestContext {
  admin: pg.Client;
  runtimeUrl: string;
  passwordFile: string;
  schema: string;
}

export async function withPostgresTestEnvironment<T>(
  label: string,
  run: (context: PostgresTestContext) => Promise<T>,
): Promise<T> {
  const testUrl = process.env.NANOCLAW_TEST_DB_URL;
  if (!testUrl) throw new Error('NANOCLAW_TEST_DB_URL is required');
  const parsed = new URL(testUrl);
  const password = decodeURIComponent(parsed.password);
  if (!password) throw new Error('NANOCLAW_TEST_DB_URL must contain a password for runtime-role tests');
  parsed.password = '';
  const runtimeUrl = parsed.toString();
  const schema = `nc_test_${label}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9_]/g, '_');
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pg-test-'));
  const passwordFile = path.join(secretDir, 'password');
  fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
  fs.chmodSync(passwordFile, 0o600);

  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.NANOCLAW_DB_URL = runtimeUrl;
  process.env.NANOCLAW_DB_PASSWORD_FILE = passwordFile;
  process.env.NANOCLAW_DB_MIGRATE_URL = runtimeUrl;
  process.env.NANOCLAW_DB_MIGRATE_PASSWORD_FILE = passwordFile;
  process.env.NANOCLAW_DB_SCHEMA = schema;

  const admin = new Client({ connectionString: testUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    return await run({ admin, runtimeUrl, passwordFile, schema });
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
    for (const key of KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
}

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
