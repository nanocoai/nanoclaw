/** Central admin-plane DB dialect (data/v2.db). Session inbound/outbound DBs stay SQLite. */
export type CentralDbDialect = 'sqlite' | 'mysql';

export type SeekDbMode = 'embedded' | 'server';

export interface CentralRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface ICentralStatement {
  run(...params: unknown[]): CentralRunResult;
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

/**
 * Sync central DB handle — matches better-sqlite3 call style used across src/db/*.
 * SeekDB implements the same surface via SeekdbClient.execute() + runSync.
 */
export interface ICentralDb {
  readonly dialect: CentralDbDialect;
  exec(sql: string): void;
  prepare(sql: string): ICentralStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
  /** SQLite only — no-op on SeekDB. */
  pragma?(name: string, value?: string): void;
}

export interface SqliteCentralDbOptions {
  path: string;
  memory?: boolean;
}

export interface SeekDbCentralDbOptions {
  mode: SeekDbMode;
  database: string;
  path?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
}
