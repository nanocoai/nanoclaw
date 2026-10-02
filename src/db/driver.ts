export type DbDialect = 'sqlite' | (string & {});

export interface RunResult {
  changes: number;
}

export type DbRole = 'host' | 'runtime' | 'migration' | 'tool' | 'test';

export interface DbConfig {
  path: string;
  /** Optional remote target supplied by an installed composition. */
  url?: string;
}

export interface DbInitOptions {
  role: DbRole;
  /** Open without mutating the local database or its journal mode. */
  readonly?: boolean;
}

export interface PrepareTestSchemaOptions {
  fresh?: boolean;
}

/** Structurally compatible with a portable migration without importing it. */
export interface DriverMigrationOverride {
  name: string;
  up: (db: DbDriver) => void | Promise<void>;
}

export interface DbMigrationHooks {
  /** Create a backend-native baseline and seed its covered migration names. */
  bootstrapSchema?: (db: DbDriver) => Promise<void>;
  /** Replace a migration whose trunk implementation is backend-specific. */
  migrationOverrides?: ReadonlyMap<string, DriverMigrationOverride>;
  /** Serialize the complete migration run outside transaction watchdogs. */
  withMigrationLock?: <T>(run: () => Promise<T>) => Promise<T>;
}

/**
 * Async central-database boundary. Session mailboxes deliberately do not use
 * this interface: the default inbound.db and outbound.db implementation is SQLite,
 * but mailbox implementations may use other storage backends.
 *
 * Transaction callbacks must issue DB calls sequentially. Do not use
 * Promise.all, and never await mailbox, container, adapter, or network work
 * while a central transaction is open. Put those effects after commit.
 */
export interface DbDriver {
  readonly dialect: DbDialect;
  readonly migrationHooks?: DbMigrationHooks;
  /** Backend-owned test isolation/reset hook. */
  prepareTestSchema?(options: PrepareTestSchemaOptions): Promise<void>;
  /** Tables containing a named column, used by backend-neutral maintenance. */
  columnOwners?(column: string): Promise<string[]>;
  get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  hasTable(name: string): Promise<boolean>;
  close(): Promise<void>;
}
