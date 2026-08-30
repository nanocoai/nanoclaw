import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { migrations } from '../src/db/migrations/index.js';
import { readPostgresEnvironment, resolvePostgresConfig } from '../src/db/drivers/postgres/config.js';

const { Client } = pg;
const MINIMUM_POSTGRES_VERSION = 150_000;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function preflightPostgres(): Promise<void> {
  const environment = readPostgresEnvironment();
  const resolved = resolvePostgresConfig({ path: '' }, { role: 'migration' }, environment);
  const client = new Client({
    connectionString: resolved.pool.connectionString,
    connectionTimeoutMillis: resolved.pool.connectionTimeoutMillis,
    application_name: 'nanoclaw-migration-preflight',
  });
  await client.connect();
  try {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    const serverVersion = Number(version.rows[0]?.server_version_num);
    if (!Number.isSafeInteger(serverVersion) || serverVersion < MINIMUM_POSTGRES_VERSION) {
      throw new Error(
        `NanoClaw requires PostgreSQL 15 or newer (found ${version.rows[0]?.server_version_num ?? 'unknown'})`,
      );
    }

    const database = await client.query<{ datcollate: string; datlocprovider: string }>(
      'SELECT datcollate, datlocprovider FROM pg_database WHERE datname = current_database()',
    );
    if (database.rows[0]?.datcollate !== 'C') {
      throw new Error(
        `NanoClaw requires PostgreSQL database collation C (found ${database.rows[0]?.datcollate ?? 'unknown'})`,
      );
    }
    if (database.rows[0]?.datlocprovider !== 'c') {
      throw new Error(
        `NanoClaw requires PostgreSQL libc locale provider (found ${database.rows[0]?.datlocprovider ?? 'unknown'})`,
      );
    }

    const schema = await client.query<{ owner: string; current_user: string }>(
      `SELECT pg_get_userbyid(n.nspowner) AS owner, current_user
         FROM pg_namespace n
        WHERE n.nspname = $1`,
      [resolved.schema],
    );
    if (schema.rowCount === 0) {
      const privilege = await client.query<{ allowed: boolean }>(
        `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed`,
      );
      if (!privilege.rows[0]?.allowed) {
        throw new Error(`Migration role cannot create PostgreSQL schema "${resolved.schema}"`);
      }
      console.log(`PostgreSQL preflight passed; schema "${resolved.schema}" will be created by migration.`);
      return;
    }
    if (schema.rows[0]?.owner !== schema.rows[0]?.current_user) {
      throw new Error(`Migration role must own PostgreSQL schema "${resolved.schema}"`);
    }

    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
      [resolved.schema],
    );
    if (tables.rowCount === 0) {
      console.log(`PostgreSQL preflight passed; schema "${resolved.schema}" is empty.`);
      return;
    }
    if (!tables.rows.some(({ table_name }) => table_name === 'schema_version')) {
      throw new Error(
        `PostgreSQL schema "${resolved.schema}" is non-empty but has no schema_version ledger; refusing migration`,
      );
    }
    const ledger = await client.query<{ name: string }>(
      `SELECT name FROM ${quoteIdentifier(resolved.schema)}.schema_version ORDER BY version`,
    );
    const known = new Set(migrations.map(({ name }) => name));
    const unknown = ledger.rows.map(({ name }) => name).filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(`PostgreSQL schema has unknown migration names: ${unknown.join(', ')}`);
    }
    console.log(
      `PostgreSQL preflight passed; schema "${resolved.schema}" has ${ledger.rowCount} recognized migration(s).`,
    );
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void preflightPostgres().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
