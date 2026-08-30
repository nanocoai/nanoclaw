import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { closeDb, initDb } from '../src/db/connection.js';
import { SqliteDriver } from '../src/db/drivers/sqlite.js';
import { quoteIdentifier, withPostgresTestEnvironment } from '../src/db/drivers/postgres/test-helpers.js';
import { migrations, runMigrations } from '../src/db/migrations/index.js';
import { importSqliteToPostgres, insertionOrder, referencedTables } from './sqlite-to-postgres.js';

const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';

describe('SQLite to PostgreSQL importer planning', () => {
  it('extracts quoted and bare foreign-key targets', () => {
    expect(
      [...referencedTables(`
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES parent(id),
          owner_id TEXT,
          FOREIGN KEY (owner_id) REFERENCES "users"(id)
        )
      `)],
    ).toEqual(['parent', 'users']);
  });

  it('orders parent tables before children and excludes the ledger', () => {
    expect(
      insertionOrder([
        { name: 'children', sql: 'CREATE TABLE children (id TEXT, parent_id TEXT REFERENCES parents(id))' },
        { name: 'schema_version', sql: 'CREATE TABLE schema_version (version INTEGER)' },
        { name: 'parents', sql: 'CREATE TABLE parents (id TEXT PRIMARY KEY)' },
      ]),
    ).toEqual(['parents', 'children']);
  });

  it('refuses dependency cycles instead of disabling PostgreSQL constraints', () => {
    expect(() =>
      insertionOrder([
        { name: 'a', sql: 'CREATE TABLE a (b_id TEXT REFERENCES b(id))' },
        { name: 'b', sql: 'CREATE TABLE b (a_id TEXT REFERENCES a(id))' },
      ]),
    ).toThrow(/dependency cycle: a, b/);
  });
});

describe.skipIf(!TEST_DB_URL)('SQLite to PostgreSQL importer', () => {
  it('imports a migrated SQLite database and reconciles the ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sqlite-import-'));
    const sourcePath = path.join(dir, 'v2.db');
    const source = new SqliteDriver(new Database(sourcePath));
    try {
      await runMigrations(source, migrations);
      await source.run(
        'INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
        'cli:imported-owner',
        'cli',
        'Imported Owner',
        new Date().toISOString(),
      );
      await source.close();

      await withPostgresTestEnvironment('import', async ({ admin, schema }) => {
        const target = await initDb(':memory:', { role: 'migration' });
        await runMigrations(target, migrations, { mode: 'migrate' });
        await closeDb();

        await importSqliteToPostgres({ source: sourcePath, commit: true, truncate: false, skipOrphans: false });

        const user = await admin.query<{ display_name: string }>(
          `SELECT display_name FROM ${quoteIdentifier(schema)}.users WHERE id = 'cli:imported-owner'`,
        );
        expect(user.rows).toEqual([{ display_name: 'Imported Owner' }]);
        const ledger = await admin.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM ${quoteIdentifier(schema)}.schema_version`,
        );
        expect(Number(ledger.rows[0]?.count)).toBe(migrations.length);
      });
    } finally {
      await closeDb();
      if (source.rawDatabase().open) await source.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
