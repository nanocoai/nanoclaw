import pg from 'pg';

import { log } from '../../../log.js';
import type { DbDriver, DbMigrationHooks, PrepareTestSchemaOptions, RunResult } from '../../driver.js';
import { DEFAULT_TRANSACTION_WATCHDOG_MS, TransactionScopeStore, withTransactionWatchdog } from '../shared.js';
import type { PostgresDbConfig, PostgresEnvironment, ResolvedPostgresConfig } from './config.js';
import { resolvePostgresConfig } from './config.js';
import { rewriteSql } from './sql-rewrite.js';
import type { DbInitOptions } from '../../driver.js';
import { POSTGRES_BASELINE_SQL } from './baseline.js';

const { Pool, types } = pg;
type Pool = pg.Pool;
type PoolClient = pg.PoolClient;

const MINIMUM_POSTGRES_VERSION = 150_000;
const SCHEMA_LOCK_NAMESPACE = 'nanoclaw:schema';
const MIGRATION_LOCK_NAMESPACE = 'nanoclaw:migrations';
const HOST_LOCK_NAMESPACE = 'nanoclaw:host';
const HOST_LOCK_ATTEMPTS = 60;
const HOST_LOCK_RECOVERY_ATTEMPTS = 10;
const HOST_LOCK_RETRY_MS = 1_000;
const LOCK_TIMEOUT_MS = 5_000;

types.setTypeParser(20, (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new RangeError(`PostgreSQL int8 is outside JavaScript's safe range: ${value}`);
  return parsed;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export class PostgresDriver implements DbDriver {
  readonly dialect = 'postgres' as const;
  readonly migrationHooks: DbMigrationHooks;

  private readonly pool: Pool;
  private readonly scopes = new TransactionScopeStore<PoolClient>();
  private readonly configuredClients = new WeakSet<PoolClient>();
  private readonly tableCache = new Set<string>();
  private hostLockClient: PoolClient | null = null;
  private hostLockErrorHandler: ((error: Error) => void) | null = null;
  private hostLockRecovery: Promise<void> | null = null;
  private recoveringHostLock = false;
  private closed = false;

  private constructor(
    private readonly config: ResolvedPostgresConfig,
    private readonly transactionWatchdogMs = DEFAULT_TRANSACTION_WATCHDOG_MS,
  ) {
    this.pool = new Pool(config.pool);
    // node-postgres emits idle-client failures on the pool. Without a listener,
    // an ordinary PG restart becomes an uncaught EventEmitter error and can
    // terminate the host before the reserved lock connection can recover.
    this.pool.on('error', (error) => {
      log.warn('Idle PostgreSQL pool connection was lost; the pool will replace it on demand', { err: error });
    });
    this.migrationHooks = {
      bootstrapSchema: async (): Promise<void> => {
        if (await this.hasTable('schema_version')) return;
        const existing = await this.get<{ count: number }>(
          `SELECT COUNT(*) AS count
             FROM information_schema.tables
            WHERE table_schema = current_schema()
              AND table_type = 'BASE TABLE'`,
        );
        if ((existing?.count ?? 0) > 0) {
          throw new Error(
            'PostgreSQL schema is non-empty but has no schema_version ledger; refusing baseline bootstrap',
          );
        }
        await this.exec(POSTGRES_BASELINE_SQL);
      },
      withMigrationLock: async <T>(run: () => Promise<T>): Promise<T> =>
        this.runTransaction(async () => {
          await this.get(`SELECT set_config('lock_timeout', '0', true)`);
          await this.get(
            `SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))`,
            MIGRATION_LOCK_NAMESPACE,
            this.config.schema,
          );
          await this.get(`SELECT set_config('lock_timeout', ?, true)`, `${LOCK_TIMEOUT_MS}ms`);
          return run();
        }, null),
    };
  }

  static async create(
    config: PostgresDbConfig,
    options: DbInitOptions,
    transactionWatchdogMs = DEFAULT_TRANSACTION_WATCHDOG_MS,
    environment?: PostgresEnvironment,
  ): Promise<PostgresDriver> {
    const driver = new PostgresDriver(resolvePostgresConfig(config, options, environment), transactionWatchdogMs);
    try {
      await driver.initialize();
      return driver;
    } catch (error) {
      await driver.close();
      throw error;
    }
  }

  private assertDriverOpen(): void {
    if (this.closed) throw new Error('Central DB driver is closed');
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      const version = await client.query<{ server_version_num: string }>(`SHOW server_version_num`);
      const serverVersion = Number(version.rows[0]?.server_version_num);
      if (!Number.isSafeInteger(serverVersion) || serverVersion < MINIMUM_POSTGRES_VERSION) {
        throw new Error(
          `NanoClaw requires PostgreSQL 15 or newer (found ${version.rows[0]?.server_version_num ?? 'unknown'})`,
        );
      }
      const database = await client.query<{ datcollate: string; datlocprovider: string }>(
        `SELECT datcollate, datlocprovider FROM pg_database WHERE datname = current_database()`,
      );
      const collation = database.rows[0]?.datcollate;
      if (collation !== 'C')
        throw new Error(`NanoClaw requires PostgreSQL database collation C (found ${collation ?? 'unknown'})`);
      const localeProvider = database.rows[0]?.datlocprovider;
      if (localeProvider !== 'c') {
        throw new Error(`NanoClaw requires PostgreSQL libc locale provider (found ${localeProvider ?? 'unknown'})`);
      }
    } finally {
      client.release();
    }

    if (this.config.role === 'migration' || this.config.role === 'test') await this.ensureSchema();
    const configured = await this.acquireClient();
    configured.release();

    if (this.config.role === 'host' && this.config.hostLock) {
      await this.acquireHostLock(HOST_LOCK_ATTEMPTS);
    }
  }

  private async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    let lockHeld = false;
    let destroy = false;
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext($1), hashtext($2))`, [
        SCHEMA_LOCK_NAMESPACE,
        this.config.schema,
      ]);
      lockHeld = true;
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.config.schema}"`);
    } catch (error) {
      destroy = true;
      throw error;
    } finally {
      if (lockHeld) {
        try {
          await client.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, [
            SCHEMA_LOCK_NAMESPACE,
            this.config.schema,
          ]);
          // The connection is destroyed below, which releases the lock even when explicit unlock fails.
          // eslint-disable-next-line no-catch-all/no-catch-all -- cleanup failure is logged and must not mask schema creation
        } catch (error) {
          destroy = true;
          log.warn('Failed to release PostgreSQL schema-provisioning lock', { err: error });
        }
      }
      client.release(destroy);
    }
  }

  private async configureClient(client: PoolClient): Promise<void> {
    if (this.configuredClients.has(client)) return;
    await client.query(`SET search_path TO "${this.config.schema}"`);
    const current = await client.query<{ current_schema: string | null }>(`SELECT current_schema()`);
    if (current.rows[0]?.current_schema !== this.config.schema) {
      throw new Error(`PostgreSQL schema "${this.config.schema}" does not exist or is not accessible to this role`);
    }
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [`${this.config.statementTimeoutMs}ms`]);
    await client.query(`SELECT set_config('lock_timeout', $1, false)`, [`${LOCK_TIMEOUT_MS}ms`]);
    if (this.config.readonly) await client.query(`SET default_transaction_read_only = on`);
    this.configuredClients.add(client);
  }

  private async acquireClient(): Promise<PoolClient> {
    this.assertDriverOpen();
    const client = await this.pool.connect();
    try {
      await this.configureClient(client);
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  private async access<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertDriverOpen();
    if (this.config.role === 'host' && this.config.hostLock && !this.hostLockClient) {
      const recovery = this.hostLockRecovery;
      if (recovery) await recovery;
      if (!this.hostLockClient) throw new Error('NanoClaw PostgreSQL host lock is not held');
    }
    const scope = this.scopes.current();
    if (scope) {
      this.scopes.assertOpen(scope);
      return fn(scope.connection);
    }
    const client = await this.acquireClient();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return this.access(async (client) => {
      const query = rewriteSql(sql, params);
      const result = await client.query<T & pg.QueryResultRow>(query.text, query.values);
      return result.rows[0] as T | undefined;
    });
  }

  async all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.access(async (client) => {
      const query = rewriteSql(sql, params);
      const result = await client.query<T & pg.QueryResultRow>(query.text, query.values);
      return result.rows as T[];
    });
  }

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    return this.access(async (client) => {
      const query = rewriteSql(sql, params);
      const result = await client.query(query.text, query.values);
      return { changes: result.rowCount ?? 0 };
    });
  }

  async exec(sql: string): Promise<void> {
    await this.access(async (client) => {
      await client.query(sql);
    });
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.assertDriverOpen();
    const parent = this.scopes.current();
    if (parent) {
      this.scopes.assertOpen(parent);
      const savepoint = this.scopes.nextSavepoint(parent);
      await parent.connection.query(`SAVEPOINT ${savepoint}`);
      parent.depth += 1;
      try {
        const result = await fn();
        this.scopes.assertOpen(parent);
        await parent.connection.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        if (!parent.closed) {
          await parent.connection.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await parent.connection.query(`RELEASE SAVEPOINT ${savepoint}`);
        }
        throw error;
      } finally {
        parent.depth -= 1;
      }
    }

    return this.runTransaction(fn, this.transactionWatchdogMs);
  }

  private async runTransaction<T>(fn: () => Promise<T>, watchdogMs: number | null): Promise<T> {
    const client = await this.acquireClient();
    const scope = { connection: client, depth: 1, closed: false, savepointSequence: 0 };
    let began = false;
    let committing = false;
    let destroy = false;
    try {
      await client.query('BEGIN');
      began = true;
      const result = await this.scopes.run(scope, () =>
        watchdogMs === null ? fn() : withTransactionWatchdog(fn, watchdogMs),
      );
      this.scopes.assertOpen(scope);
      scope.closed = true;
      committing = true;
      await client.query('COMMIT');
      began = false;
      return result;
    } catch (error) {
      scope.closed = true;
      if (!began || committing) destroy = true;
      if (began) {
        try {
          await client.query('ROLLBACK');
          // eslint-disable-next-line no-catch-all/no-catch-all -- preserve the callback error used by retry classification
        } catch (rollbackError) {
          destroy = true;
          log.warn('PostgreSQL transaction rollback failed; discarding the connection', { err: rollbackError });
        }
      }
      throw error;
    } finally {
      scope.closed = true;
      client.release(destroy);
    }
  }

  async hasTable(name: string): Promise<boolean> {
    if (this.tableCache.has(name)) return true;
    const row = await this.get<{ table_name: string | null }>('SELECT to_regclass(?) AS table_name', name);
    if (row?.table_name) this.tableCache.add(name);
    return Boolean(row?.table_name);
  }

  async prepareTestSchema(options: PrepareTestSchemaOptions): Promise<void> {
    if (this.config.role !== 'test') throw new Error('PostgreSQL test-schema preparation requires the test role');
    if (options.fresh) {
      await this.exec(`DROP SCHEMA IF EXISTS "${this.config.schema}" CASCADE; CREATE SCHEMA "${this.config.schema}";`);
      this.tableCache.clear();
      return;
    }
    if (!(await this.hasTable('schema_version'))) return;
    const tables = await this.all<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_type = 'BASE TABLE'
          AND table_name <> 'schema_version'
        ORDER BY table_name`,
    );
    if (tables.length === 0) return;
    const names = tables.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(', ');
    await this.exec(`TRUNCATE TABLE ${names} CASCADE`);
  }

  async columnOwners(column: string): Promise<string[]> {
    const rows = await this.all<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = ?
        ORDER BY table_name`,
      column,
    );
    return rows.map(({ table_name }) => table_name);
  }

  private async tryAcquireHostLock(): Promise<boolean> {
    const client = await this.acquireClient();
    try {
      const result = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired`,
        [HOST_LOCK_NAMESPACE, this.config.schema],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return false;
      }
      this.hostLockClient = client;
      const errorHandler = (error: Error): void => {
        if (this.hostLockClient !== client) return;
        this.hostLockClient = null;
        this.hostLockErrorHandler = null;
        client.release(error);
        log.warn('NanoClaw PostgreSQL host lock connection was lost; pausing database access during recovery');
        const recovery = this.recoverHostLock();
        this.hostLockRecovery = recovery;
        void recovery.catch(() => undefined);
      };
      this.hostLockErrorHandler = errorHandler;
      client.on('error', errorHandler);
      return true;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  private async acquireHostLock(attempts: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (await this.tryAcquireHostLock()) return;
        lastError = new Error('another NanoClaw host owns the PostgreSQL singleton lock');
      } catch (error) {
        lastError = error;
      }
      if (attempt < attempts) await delay(HOST_LOCK_RETRY_MS);
    }
    throw new Error(`Could not acquire NanoClaw PostgreSQL host lock after ${attempts} attempts`, { cause: lastError });
  }

  private async recoverHostLock(): Promise<void> {
    if (this.closed || this.recoveringHostLock) return;
    this.recoveringHostLock = true;
    try {
      await this.acquireHostLock(HOST_LOCK_RECOVERY_ATTEMPTS);
      log.info('NanoClaw PostgreSQL host lock recovered');
    } catch (error) {
      if (this.closed) return;
      log.error('NanoClaw PostgreSQL host lock could not be recovered; exiting to prevent double delivery', {
        err: error,
      });
      process.exit(1);
    } finally {
      this.recoveringHostLock = false;
      this.hostLockRecovery = null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const lockClient = this.hostLockClient;
    const lockErrorHandler = this.hostLockErrorHandler;
    this.hostLockClient = null;
    this.hostLockErrorHandler = null;
    if (lockClient) {
      let unlockError: Error | undefined;
      try {
        await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, [
          HOST_LOCK_NAMESPACE,
          this.config.schema,
        ]);
      } catch (error) {
        unlockError = error instanceof Error ? error : new Error(String(error));
        log.warn('Failed to explicitly release NanoClaw PostgreSQL host lock during shutdown', { err: error });
      } finally {
        lockClient.release(unlockError);
        if (lockErrorHandler) lockClient.removeListener('error', lockErrorHandler);
      }
    }
    this.tableCache.clear();
    await this.pool.end();
  }
}

export function createPostgresDriver(
  config: PostgresDbConfig,
  options: DbInitOptions,
  environment?: PostgresEnvironment,
): Promise<PostgresDriver> {
  return PostgresDriver.create(config, options, DEFAULT_TRANSACTION_WATCHDOG_MS, environment);
}
