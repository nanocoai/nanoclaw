import type { SeekdbClientArgs } from 'seekdb';

import { log } from '../../log.js';
import { bindExecuteParams, splitSqlStatements } from './sql-params.js';
import { SeekDbWorkerBridge } from './seekdb-sync-rpc.js';
import type { CentralRunResult, ICentralDb, ICentralStatement, SeekDbCentralDbOptions } from './types.js';

function asRows(result: Record<string, unknown>[] | null | undefined): Record<string, unknown>[] {
  return result ?? [];
}

function buildClientArgs(options: SeekDbCentralDbOptions): SeekdbClientArgs {
  if (options.mode === 'embedded') {
    if (!options.path) throw new Error('SEEKDB_PATH is required for embedded SeekDB');
    return { path: options.path, database: options.database };
  }
  const args: SeekdbClientArgs = {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 2881,
    user: options.user ?? 'root',
    password: options.password ?? '',
    database: options.database,
  };
  return args;
}

function buildAdminArgs(options: SeekDbCentralDbOptions): SeekdbClientArgs {
  if (options.mode === 'embedded') {
    if (!options.path) throw new Error('SEEKDB_PATH is required for embedded SeekDB');
    return { path: options.path };
  }
  const args: SeekdbClientArgs = {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 2881,
    user: options.user ?? 'root',
    password: options.password ?? '',
  };
  return args;
}

let sharedBridge: SeekDbWorkerBridge | null = null;

function getBridge(): SeekDbWorkerBridge {
  if (!sharedBridge) sharedBridge = SeekDbWorkerBridge.openSync();
  return sharedBridge;
}

function statementForBridge(bridge: SeekDbWorkerBridge, sql: string): ICentralStatement {
  return {
    run(...params: unknown[]): CentralRunResult {
      const { sql: bound, values } = bindExecuteParams(sql, params);
      bridge.call('execute', { sql: bound, values });
      return { changes: 1 };
    },
    get<T>(...params: unknown[]): T | undefined {
      const { sql: bound, values } = bindExecuteParams(sql, params);
      const rows = asRows(bridge.call<Record<string, unknown>[] | null>('execute', { sql: bound, values }));
      return (rows[0] as T | undefined) ?? undefined;
    },
    all<T>(...params: unknown[]): T[] {
      const { sql: bound, values } = bindExecuteParams(sql, params);
      return asRows(bridge.call<Record<string, unknown>[] | null>('execute', { sql: bound, values })) as T[];
    },
  };
}

export class SeekDbCentralDb implements ICentralDb {
  readonly dialect = 'mysql' as const;
  private readonly bridge: SeekDbWorkerBridge;

  constructor(options: SeekDbCentralDbOptions) {
    this.bridge = getBridge();
    this.bridge.call('client-open', { args: buildClientArgs(options) });
    log.info('Central DB initialized (seekdb)', {
      mode: options.mode,
      database: options.database,
      path: options.path,
      host: options.host,
      port: options.port,
    });
  }

  exec(sql: string): void {
    for (const stmt of splitSqlStatements(sql)) {
      this.bridge.call('execute', { sql: stmt, values: [] });
    }
  }

  prepare(sql: string): ICentralStatement {
    return statementForBridge(this.bridge, sql);
  }

  transaction<T>(fn: () => T): T {
    this.exec('START TRANSACTION');
    try {
      const result = fn();
      this.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
  }

  close(): void {
    this.bridge.call('client-close');
  }
}

/** Create logical database if missing (embedded or server). */
export function ensureSeekDbDatabase(options: SeekDbCentralDbOptions): void {
  getBridge().call('admin-ensure-db', {
    args: buildAdminArgs(options),
    database: options.database,
  });
}

/** Tear down shared worker (tests). */
export function shutdownSeekDbWorker(): void {
  if (sharedBridge) {
    sharedBridge.terminate();
    sharedBridge = null;
  }
}
