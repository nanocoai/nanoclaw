import Database from 'better-sqlite3';

import type { DbDriver, RunResult } from '../driver.js';
import {
  AsyncMutex,
  DEFAULT_TRANSACTION_WATCHDOG_MS,
  TransactionScopeStore,
  withTransactionWatchdog,
} from './shared.js';

type SqliteDatabase = Database.Database;

function isNamedParams(params: unknown[]): params is [Record<string, unknown>] {
  return params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0]);
}

export class SqliteDriver implements DbDriver {
  readonly dialect = 'sqlite' as const;

  private readonly scopes = new TransactionScopeStore<SqliteDatabase>();
  private readonly transactionMutex = new AsyncMutex();
  private activeTransaction: Promise<void> | null = null;
  private finishActiveTransaction: (() => void) | null = null;
  private readonly tableCache = new Set<string>();
  private closed = false;

  constructor(
    private readonly raw: SqliteDatabase,
    private readonly transactionWatchdogMs = DEFAULT_TRANSACTION_WATCHDOG_MS,
  ) {}

  rawDatabase(): SqliteDatabase {
    return this.raw;
  }

  private assertDriverOpen(): void {
    if (this.closed) throw new Error('Central DB driver is closed');
  }

  private async access<T>(fn: (db: SqliteDatabase) => T): Promise<T> {
    this.assertDriverOpen();
    const scope = this.scopes.current();
    if (scope) {
      this.scopes.assertOpen(scope);
      return fn(scope.connection);
    }
    while (this.activeTransaction) await this.activeTransaction;
    this.assertDriverOpen();
    return fn(this.raw);
  }

  async get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.access((db) => {
      const statement = db.prepare(sql);
      return (isNamedParams(params) ? statement.get(params[0]) : statement.get(...params)) as T | undefined;
    });
  }

  async all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.access((db) => {
      const statement = db.prepare(sql);
      return (isNamedParams(params) ? statement.all(params[0]) : statement.all(...params)) as T[];
    });
  }

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    return this.access((db) => {
      const statement = db.prepare(sql);
      const result = isNamedParams(params) ? statement.run(params[0]) : statement.run(...params);
      return { changes: result.changes };
    });
  }

  async exec(sql: string): Promise<void> {
    await this.access((db) => {
      db.exec(sql);
    });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertDriverOpen();
    const parent = this.scopes.current();
    if (parent) {
      this.scopes.assertOpen(parent);
      const savepoint = this.scopes.nextSavepoint(parent);
      parent.connection.exec(`SAVEPOINT ${savepoint}`);
      parent.depth += 1;
      try {
        const result = await fn();
        this.scopes.assertOpen(parent);
        parent.connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        if (!parent.closed) {
          parent.connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          parent.connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
        throw error;
      } finally {
        parent.depth -= 1;
      }
    }

    const releaseMutex = await this.transactionMutex.acquire();
    let resolveGate!: () => void;
    this.activeTransaction = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    this.finishActiveTransaction = resolveGate;
    const scope = { connection: this.raw, depth: 1, closed: false, savepointSequence: 0 };
    let began = false;
    try {
      this.raw.exec('BEGIN IMMEDIATE');
      began = true;
      const result = await this.scopes.run(scope, () => withTransactionWatchdog(fn, this.transactionWatchdogMs));
      this.scopes.assertOpen(scope);
      scope.closed = true;
      this.raw.exec('COMMIT');
      began = false;
      return result;
    } catch (error) {
      scope.closed = true;
      if (began && this.raw.inTransaction) this.raw.exec('ROLLBACK');
      throw error;
    } finally {
      scope.closed = true;
      this.finishActiveTransaction?.();
      this.finishActiveTransaction = null;
      this.activeTransaction = null;
      releaseMutex();
    }
  }

  async hasTable(name: string): Promise<boolean> {
    if (this.tableCache.has(name)) return true;
    const row = await this.get<{ present: number }>(
      `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
      name,
    );
    if (row) this.tableCache.add(name);
    return row !== undefined;
  }

  async columnOwners(column: string): Promise<string[]> {
    const rows = await this.all<{ name: string }>(
      `SELECT DISTINCT m.name
         FROM sqlite_master m
         JOIN pragma_table_info(m.name) p ON p.name = ?
        WHERE m.type = 'table'
        ORDER BY m.name`,
      column,
    );
    return rows.map(({ name }) => name);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.activeTransaction) await this.activeTransaction;
    this.raw.close();
    this.closed = true;
    this.tableCache.clear();
  }
}

export function sqliteRaw(driver: DbDriver): SqliteDatabase {
  if (!(driver instanceof SqliteDriver)) throw new Error('SQLite-only operation requires the SQLite central DB driver');
  return driver.rawDatabase();
}
