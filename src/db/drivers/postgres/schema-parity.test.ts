import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbDriver } from '../../driver.js';
import { SqliteDriver } from '../sqlite.js';
import { migrations, runMigrations } from '../../migrations/index.js';
import type { PostgresDbConfig } from './config.js';
import { PostgresDriver } from './index.js';

const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';

interface ColumnShape {
  table: string;
  column: string;
  type: string;
  nullable: boolean;
}

interface ForeignKeyShape {
  table: string;
  column: string;
  targetTable: string;
  targetColumn: string;
  onDelete: string;
}

describe.skipIf(!TEST_DB_URL)('PostgreSQL baseline parity', () => {
  const schema = `nc_test_parity_${process.pid}`;
  let sqlite: SqliteDriver;
  let postgres: DbDriver;

  beforeAll(async () => {
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = ON');
    sqlite = new SqliteDriver(raw);
    await runMigrations(sqlite, migrations);
    postgres = await PostgresDriver.create(
      {
        path: '',
        url: TEST_DB_URL,
        migrateUrl: '',
        schema,
        passwordFile: '',
        statementTimeoutMs: 30_000,
        hostLock: false,
      } satisfies PostgresDbConfig,
      { role: 'test' },
    );
    await postgres.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}";`);
    await runMigrations(postgres, migrations, { mode: 'migrate' });
  });

  afterAll(async () => {
    await sqlite.close();
    await postgres.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await postgres.close();
  });

  it('matches tables, columns, integer width, and nullability', async () => {
    const raw = sqlite.rawDatabase();
    const tableNames = (
      raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    const sqliteColumns: ColumnShape[] = tableNames.flatMap((table) =>
      (
        raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          pk: number;
        }>
      ).map((column) => ({
        table,
        column: column.name,
        type: column.type.toLowerCase() === 'integer' ? 'bigint' : column.type.toLowerCase(),
        nullable:
          (table === 'user_roles' && column.name === 'agent_group_id') || (column.notnull === 0 && column.pk === 0),
      })),
    );
    const postgresColumns = await postgres.all<{
      table: string;
      column: string;
      type: string;
      is_nullable: string;
    }>(
      `SELECT table_name AS table, column_name AS column, data_type AS type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
        ORDER BY table_name, ordinal_position`,
    );
    expect(
      postgresColumns.map(({ table, column, type, is_nullable }) => ({
        table,
        column,
        type,
        nullable: is_nullable === 'YES',
      })),
    ).toEqual(sqliteColumns);
  });

  it('matches foreign keys and explicit indexes, with expiry indexes as the documented addition', async () => {
    const raw = sqlite.rawDatabase();
    const tableNames = (
      raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    const sqliteForeignKeys: ForeignKeyShape[] = tableNames
      .flatMap((table) =>
        (
          raw.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
            from: string;
            table: string;
            to: string;
            on_delete: string;
          }>
        ).map((foreignKey) => ({
          table,
          column: foreignKey.from,
          targetTable: foreignKey.table,
          targetColumn: foreignKey.to,
          onDelete: foreignKey.on_delete,
        })),
      )
      .sort((left, right) => `${left.table}:${left.column}`.localeCompare(`${right.table}:${right.column}`, 'en'));
    const postgresForeignKeys = await postgres.all<ForeignKeyShape>(
      `SELECT tc.table_name AS table,
              kcu.column_name AS column,
              ccu.table_name AS "targetTable",
              ccu.column_name AS "targetColumn",
              rc.delete_rule AS "onDelete"
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_schema = ccu.constraint_schema AND tc.constraint_name = ccu.constraint_name
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_schema = rc.constraint_schema AND tc.constraint_name = rc.constraint_name
        WHERE tc.constraint_schema = current_schema() AND tc.constraint_type = 'FOREIGN KEY'
        ORDER BY tc.table_name, kcu.column_name`,
    );
    expect(postgresForeignKeys).toEqual(sqliteForeignKeys);

    const sqliteIndexes = (
      raw
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
    const postgresIndexes = (
      await postgres.all<{ name: string }>(
        `SELECT indexname AS name FROM pg_indexes
          WHERE schemaname = current_schema() AND indexname LIKE 'idx_%'
          ORDER BY indexname`,
      )
    ).map(({ name }) => name);
    expect(postgresIndexes).toEqual(
      [
        ...sqliteIndexes,
        'idx_chat_sdk_kv_expires_at',
        'idx_chat_sdk_lists_expires_at',
        'idx_chat_sdk_locks_expires_at',
      ].sort(),
    );
  });
});
