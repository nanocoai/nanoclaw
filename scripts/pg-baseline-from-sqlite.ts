import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { SqliteDriver } from '../src/db/drivers/sqlite.js';
import { migrations, runMigrations } from '../src/db/migrations/index.js';

interface SchemaRow {
  type: 'table' | 'index';
  name: string;
  tbl_name: string;
  sql: string;
}

interface ForeignKeyDefinition {
  table: string;
  localColumn: string;
  target: string;
  targetColumn: string;
  suffix: string;
}

const BASELINE_PATH = path.resolve('src/db/drivers/postgres/baseline.sql');
const BASELINE_TS_PATH = path.resolve('src/db/drivers/postgres/baseline.ts');

export function splitClauses(body: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quote) {
      if (char === quote && body[index + 1] === quote) index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      clauses.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  clauses.push(body.slice(start).trim());
  return clauses.filter(Boolean);
}

function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function portableClause(table: string, clause: string, foreignKeys: ForeignKeyDefinition[]): string | null {
  if (table === 'user_roles' && /^PRIMARY\s+KEY\b/i.test(clause)) return null;

  const firstIdentifier = /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(clause);
  const localColumn = firstIdentifier?.[1] ?? firstIdentifier?.[2];
  const reference =
    /\s+REFERENCES\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\(\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*)/i.exec(
      clause,
    );
  if (reference && localColumn) {
    foreignKeys.push({
      table,
      localColumn,
      target: reference[1] ?? reference[2],
      targetColumn: reference[3] ?? reference[4],
      suffix: reference[5].trim(),
    });
    clause = `${clause.slice(0, reference.index)}${clause.slice(reference.index + reference[0].length)}`.trim();
  }

  return clause
    .replace(
      /DEFAULT\s*\(datetime\('now'\)\)/gi,
      `DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
    )
    .replace(/\bINTEGER\b/gi, 'bigint')
    .replace(/\bTEXT\b/gi, 'text')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderTable(row: SchemaRow, foreignKeys: ForeignKeyDefinition[]): string {
  const sql = stripComments(row.sql);
  const open = sql.indexOf('(');
  const close = sql.lastIndexOf(')');
  if (open === -1 || close === -1) throw new Error(`Cannot parse SQLite table ${row.name}`);
  const clauses = splitClauses(sql.slice(open + 1, close))
    .map((clause) => portableClause(row.name, clause, foreignKeys))
    .filter((clause): clause is string => clause !== null);
  return `CREATE TABLE "${row.name}" (\n  ${clauses.join(',\n  ')}\n);`;
}

function renderIndex(row: SchemaRow): string {
  return `${stripComments(row.sql).replace(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, 'CREATE $1INDEX IF NOT EXISTS')};`;
}

function renderForeignKey(foreignKey: ForeignKeyDefinition): string {
  const name = `fk_${foreignKey.table}_${foreignKey.localColumn}`;
  return `ALTER TABLE "${foreignKey.table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${foreignKey.localColumn}") REFERENCES "${foreignKey.target}" ("${foreignKey.targetColumn}")${foreignKey.suffix ? ` ${foreignKey.suffix}` : ''};`;
}

export async function generatePostgresBaseline(): Promise<string> {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  const db = new SqliteDriver(raw);
  const legacyMigrations = migrations.filter((migration) => migration.sqliteOnly);
  try {
    await runMigrations(db, legacyMigrations);
    const rows = raw
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_schema
          WHERE sql IS NOT NULL AND type IN ('table', 'index')
          ORDER BY type, name`,
      )
      .all() as SchemaRow[];
    const foreignKeys: ForeignKeyDefinition[] = [];
    const tables = rows.filter((row) => row.type === 'table').map((row) => renderTable(row, foreignKeys));
    const indexes = rows.filter((row) => row.type === 'index').map(renderIndex);
    indexes.push(
      'CREATE INDEX IF NOT EXISTS idx_chat_sdk_kv_expires_at ON chat_sdk_kv(expires_at);',
      'CREATE INDEX IF NOT EXISTS idx_chat_sdk_lists_expires_at ON chat_sdk_lists(expires_at);',
      'CREATE INDEX IF NOT EXISTS idx_chat_sdk_locks_expires_at ON chat_sdk_locks(expires_at);',
    );
    indexes.sort();
    foreignKeys.sort((left, right) =>
      `${left.table}:${left.localColumn}`.localeCompare(`${right.table}:${right.localColumn}`, 'en'),
    );
    const applied = legacyMigrations
      .map(
        (migration, index) =>
          `  (${index + 1}, '${migration.name.replaceAll("'", "''")}', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
      )
      .join(',\n');

    return (
      [
        '-- Generated by scripts/pg-baseline-from-sqlite.ts. Do not edit by hand.',
        '-- Covers the frozen SQLite-only migration set; portable migrations run afterward.',
        '',
        ...tables,
        '',
        ...foreignKeys.map(renderForeignKey),
        '',
        ...indexes,
        '',
        'INSERT INTO schema_version (version, name, applied) VALUES',
        applied,
        'ON CONFLICT (name) DO NOTHING;',
      ].join('\n\n') + '\n'
    );
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const baseline = await generatePostgresBaseline();
  const moduleSource = `/** Generated by scripts/pg-baseline-from-sqlite.ts. */\nexport const POSTGRES_BASELINE_SQL = ${JSON.stringify(baseline)};\n`;
  if (process.argv.includes('--write')) {
    fs.writeFileSync(BASELINE_PATH, baseline);
    fs.writeFileSync(BASELINE_TS_PATH, moduleSource);
    return;
  }
  const currentSql = fs.existsSync(BASELINE_PATH) ? fs.readFileSync(BASELINE_PATH, 'utf8') : '';
  if (currentSql !== baseline) {
    throw new Error('PostgreSQL baseline is stale; run `pnpm run pg-baseline:generate`');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
