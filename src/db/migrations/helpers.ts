import type { ICentralDb, CentralDbDialect } from '../central/types.js';

export interface MigrationContext {
  dialect: CentralDbDialect;
}

export function execDialect(db: ICentralDb, ctx: MigrationContext, sql: { sqlite: string; mysql: string }): void {
  db.exec(ctx.dialect === 'mysql' ? sql.mysql : sql.sqlite);
}

export function hasIndex(db: ICentralDb, ctx: MigrationContext, table: string, indexName: string): boolean {
  if (ctx.dialect === 'sqlite') {
    const row = db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name = ? LIMIT 1`)
      .get(table, indexName) as { ok: number } | undefined;
    return row !== undefined;
  }
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?
       LIMIT 1`,
    )
    .get(table, indexName) as { ok: number } | undefined;
  return row !== undefined;
}

export function hasColumn(db: ICentralDb, ctx: MigrationContext, table: string, column: string): boolean {
  if (ctx.dialect === 'sqlite') {
    const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  }
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
       LIMIT 1`,
    )
    .get(table, column) as { ok: number } | undefined;
  return row !== undefined;
}

/** MySQL table suffix for InnoDB + FK support. SQLite uses empty string. */
export function tableSuffix(ctx: MigrationContext): string {
  return ctx.dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
}

/** Primary / foreign key columns — SeekDB cannot index TEXT keys. */
export function colId(ctx: MigrationContext): string {
  return ctx.dialect === 'mysql' ? 'VARCHAR(64)' : 'TEXT';
}

/** Short indexed strings (UNIQUE, channel ids, folder names). */
export function colText(ctx: MigrationContext): string {
  return ctx.dialect === 'mysql' ? 'VARCHAR(512)' : 'TEXT';
}

/** Unindexed text payloads. */
export function colLongText(ctx: MigrationContext): string {
  return 'TEXT';
}

/** JSON / config columns that need DEFAULT on MySQL (TEXT cannot have defaults). */
export function colJson(ctx: MigrationContext): string {
  return ctx.dialect === 'mysql' ? 'VARCHAR(8192)' : 'TEXT';
}

/** Quote reserved identifiers (e.g. `key`) for MySQL / SeekDB. */
export function qIdent(ctx: MigrationContext, name: string): string {
  return ctx.dialect === 'mysql' ? `\`${name}\`` : name;
}

export function nowDefault(ctx: MigrationContext): string {
  return ctx.dialect === 'mysql' ? 'CURRENT_TIMESTAMP' : "(datetime('now'))";
}

export function colTimestamp(ctx: MigrationContext): string {
  return ctx.dialect === 'mysql' ? 'TIMESTAMP' : 'TEXT';
}
