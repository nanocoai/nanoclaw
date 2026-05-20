import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import type { ICentralDb, ICentralStatement, SqliteCentralDbOptions } from './types.js';

function wrapStatement(stmt: Database.Statement): ICentralStatement {
  return {
    run(...params: unknown[]) {
      const info =
        params.length === 1 && params[0] !== null && typeof params[0] === 'object'
          ? stmt.run(params[0] as Record<string, unknown>)
          : stmt.run(...(params as Parameters<Database.Statement['run']>));
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
    get<T>(...params: unknown[]) {
      if (params.length === 1 && params[0] !== null && typeof params[0] === 'object') {
        return stmt.get(params[0] as Record<string, unknown>) as T | undefined;
      }
      return stmt.get(...(params as Parameters<Database.Statement['get']>)) as T | undefined;
    },
    all<T>(...params: unknown[]) {
      if (params.length === 1 && params[0] !== null && typeof params[0] === 'object') {
        return stmt.all(params[0] as Record<string, unknown>) as T[];
      }
      return stmt.all(...(params as Parameters<Database.Statement['all']>)) as T[];
    },
  };
}

export class SqliteCentralDb implements ICentralDb {
  readonly dialect = 'sqlite' as const;
  private readonly db: Database.Database;

  constructor(options: SqliteCentralDbOptions) {
    if (options.memory) {
      this.db = new Database(':memory:');
    } else {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      this.db = new Database(options.path);
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    log.info('Central DB initialized (sqlite)', { path: options.memory ? ':memory:' : options.path });
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): ICentralStatement {
    return wrapStatement(this.db.prepare(sql));
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  pragma(name: string, value?: string): void {
    if (value === undefined) {
      this.db.pragma(name);
    } else {
      this.db.pragma(`${name} = ${value}`);
    }
  }

  close(): void {
    this.db.close();
  }
}
