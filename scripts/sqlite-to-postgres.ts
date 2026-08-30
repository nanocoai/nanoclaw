import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';
import { migrations, runMigrations } from '../src/db/migrations/index.js';
import { splitClauses } from './pg-baseline-from-sqlite.js';

export interface ImportOptions {
  source: string;
  commit: boolean;
  truncate: boolean;
  skipOrphans: boolean;
}

interface SchemaRow {
  name: string;
  sql: string;
}

interface LedgerRow {
  version: number | bigint;
  name: string;
  applied: string;
}

interface ForeignKeyViolation {
  table: string;
  rowid: number | bigint | null;
  parent: string;
  fkid: number | bigint;
}

const CHUNK_ROWS = 500;

function usage(): never {
  console.error(
    'Usage: pnpm exec tsx scripts/sqlite-to-postgres.ts [--source <data/v2.db>] [--dry-run|--commit] [--truncate] [--skip-orphans]',
  );
  process.exit(2);
}

function parseArgs(argv: string[]): ImportOptions {
  const options: ImportOptions = { source: CENTRAL_DB_PATH, commit: false, truncate: false, skipOrphans: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--source') {
      const source = argv[++index];
      if (!source) usage();
      options.source = path.resolve(source);
    } else if (arg === '--dry-run') {
      options.commit = false;
    } else if (arg === '--commit') {
      options.commit = true;
    } else if (arg === '--truncate') {
      options.truncate = true;
    } else if (arg === '--skip-orphans') {
      options.skipOrphans = true;
    } else {
      usage();
    }
  }
  return options;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sourceTables(source: Database.Database): SchemaRow[] {
  return source
    .prepare(
      `SELECT name, sql
         FROM sqlite_schema
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND sql IS NOT NULL
        ORDER BY name`,
    )
    .all() as SchemaRow[];
}

export function referencedTables(createSql: string): Set<string> {
  const open = createSql.indexOf('(');
  const close = createSql.lastIndexOf(')');
  if (open < 0 || close < open) throw new Error('Cannot parse a SQLite CREATE TABLE statement');
  const targets = new Set<string>();
  for (const clause of splitClauses(createSql.slice(open + 1, close))) {
    const references = /\bREFERENCES\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi;
    for (const match of clause.matchAll(references)) targets.add(match[1] ?? match[2]);
  }
  return targets;
}

export function insertionOrder(rows: SchemaRow[]): string[] {
  const names = new Set(rows.map(({ name }) => name).filter((name) => name !== 'schema_version'));
  const dependencies = new Map(
    rows
      .filter(({ name }) => names.has(name))
      .map(({ name, sql }) => [
        name,
        new Set([...referencedTables(sql)].filter((target) => names.has(target) && target !== name)),
      ]),
  );
  const ordered: string[] = [];
  while (ordered.length < names.size) {
    const ready = [...names]
      .filter((name) => !ordered.includes(name))
      .filter((name) => [...(dependencies.get(name) ?? [])].every((parent) => ordered.includes(parent)))
      .sort();
    if (ready.length === 0) {
      const blocked = [...names].filter((name) => !ordered.includes(name)).sort();
      throw new Error(`Cannot determine a foreign-key-safe table order; dependency cycle: ${blocked.join(', ')}`);
    }
    ordered.push(...ready);
  }
  return ordered;
}

function verifySourceLedger(source: Database.Database): LedgerRow[] {
  const actual = source.prepare('SELECT version, name, applied FROM schema_version ORDER BY version').all() as LedgerRow[];
  const expectedNames = migrations.map(({ name }) => name).sort();
  const actualNames = actual.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    const missing = expectedNames.filter((name) => !actualNames.includes(name));
    const unknown = actualNames.filter((name) => !expectedNames.includes(name));
    throw new Error(
      `SQLite migration ledger does not match this importer (missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'})`,
    );
  }
  return actual;
}

function verifySourceForeignKeys(source: Database.Database, skipOrphans: boolean): ForeignKeyViolation[] {
  const violations = source.pragma('foreign_key_check') as ForeignKeyViolation[];
  if (violations.length > 0 && !skipOrphans) {
    throw new Error(
      `SQLite source has ${violations.length} foreign-key orphan(s); repair them or re-run with --skip-orphans after reviewing the report: ${stringify(violations.slice(0, 20))}`,
    );
  }
  return violations;
}

function stringify(value: unknown, spacing?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item), spacing);
}

async function targetTables(target: DbDriver): Promise<string[]> {
  const rows = await target.all<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  return rows.map(({ table_name }) => table_name);
}

function assertMatchingTables(source: string[], target: string[]): void {
  const sourceSet = new Set(source);
  const targetSet = new Set(target);
  const missing = source.filter((name) => !targetSet.has(name));
  const extra = target.filter((name) => !sourceSet.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `SQLite/PostgreSQL table sets differ (missing target tables: ${missing.join(', ') || 'none'}; extra target tables: ${extra.join(', ') || 'none'})`,
    );
  }
}

async function tableCounts(target: DbDriver, tables: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = await target.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
    counts[table] = row?.count ?? 0;
  }
  return counts;
}

function sourceRows(source: Database.Database, table: string): Record<string, unknown>[] {
  return (source.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all() as Record<string, unknown>[]).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([column, value]) => [column, typeof value === 'bigint' ? value.toString() : value]),
    ),
  );
}

async function insertTable(target: DbDriver, table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const columnSql = columns.map(quoteIdentifier).join(', ');
  for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
    const chunk = rows.slice(start, start + CHUNK_ROWS);
    const values = chunk.flatMap((row) => columns.map((column) => row[column]));
    const rowSql = `(${columns.map(() => '?').join(', ')})`;
    await target.transaction(async () => {
      await target.run(
        `INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES ${chunk.map(() => rowSql).join(', ')}`,
        ...values,
      );
    });
  }
}

async function replaceLedger(target: DbDriver, ledger: LedgerRow[]): Promise<void> {
  await target.transaction(async () => {
    await target.run('DELETE FROM schema_version');
    for (const row of ledger) {
      await target.run(
        'INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)',
        String(row.version),
        row.name,
        row.applied,
      );
    }
  });
}

export async function importSqliteToPostgres(options: ImportOptions): Promise<void> {
  const source = new Database(options.source, { readonly: true, fileMustExist: true });
  source.defaultSafeIntegers(true);
  let target: DbDriver | null = null;
  try {
    const sourceSchema = sourceTables(source);
    const ledger = verifySourceLedger(source);
    const orphans = verifySourceForeignKeys(source, options.skipOrphans);
    const tables = insertionOrder(sourceSchema);
    const sourceCounts = Object.fromEntries(tables.map((table) => [table, sourceRows(source, table).length]));

    target = await initDb(CENTRAL_DB_PATH, { role: 'migration' });
    await runMigrations(target, undefined, { mode: 'validate' });
    const postgresTables = await targetTables(target);
    assertMatchingTables(sourceSchema.map(({ name }) => name), postgresTables);
    const before = await tableCounts(target, tables);
    const populated = Object.entries(before).filter(([, count]) => count > 0);
    if (populated.length > 0 && !options.truncate) {
      throw new Error(
        `PostgreSQL target is not empty (${populated.map(([name, count]) => `${name}=${count}`).join(', ')}); re-run with --truncate only after reviewing the target`,
      );
    }

    const plan = {
      mode: options.commit ? 'commit' : 'dry-run',
      source: options.source,
      tables,
      rows: sourceCounts,
      targetRowsBefore: before,
      sourceOrphans: orphans,
      truncate: options.truncate,
    };
    console.log(stringify(plan, 2));
    if (!options.commit) return;

    if (options.truncate && tables.length > 0) {
      await target.transaction(async () => {
        await target!.exec(`TRUNCATE TABLE ${tables.map(quoteIdentifier).join(', ')} CASCADE`);
      });
    }
    for (const table of tables) await insertTable(target, table, sourceRows(source, table));
    await replaceLedger(target, ledger);

    const after = await tableCounts(target, tables);
    const mismatches = tables.filter((table) => after[table] !== sourceCounts[table]);
    if (mismatches.length > 0) {
      throw new Error(
        `PostgreSQL row-count verification failed: ${mismatches.map((table) => `${table}: source=${sourceCounts[table]} target=${after[table]}`).join(', ')}`,
      );
    }
    const targetLedger = (await target.all<LedgerRow>('SELECT version, name, applied FROM schema_version ORDER BY version')).map(
      ({ version, name, applied }) => ({ version: String(version), name, applied }),
    );
    const sourceLedger = ledger.map(({ version, name, applied }) => ({ version: String(version), name, applied }));
    if (JSON.stringify(targetLedger) !== JSON.stringify(sourceLedger)) {
      throw new Error('PostgreSQL schema_version reconciliation failed');
    }
    console.log(stringify({ imported: true, rows: after, ledgerRows: ledger.length }));
  } finally {
    source.close();
    if (target) await closeDb();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void importSqliteToPostgres(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
