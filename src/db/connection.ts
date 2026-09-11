import Database from 'better-sqlite3';

import { CENTRAL_DB_PATH } from '../config.js';
import { log } from '../log.js';
import type { DbConfig, DbDriver, DbInitOptions } from './driver.js';
import { createDbDriver } from './driver-registry.js';
import { SqliteDriver } from './drivers/sqlite.js';
import { runMigrations } from './migrations/index.js';

import './compose.js';

let _db: DbDriver | null = null;

export function getDb(): DbDriver {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

function defaultConfig(): DbConfig {
  return { path: CENTRAL_DB_PATH };
}

export async function initDb(
  target: string | Partial<DbConfig> = CENTRAL_DB_PATH,
  options: DbInitOptions = { role: 'runtime' },
): Promise<DbDriver> {
  if (_db) throw new Error('Central DB is already initialized');
  const config = { ...defaultConfig(), ...(typeof target === 'string' ? { path: target } : target) };
  _db = await createDbDriver(config, options);
  if (options.role !== 'tool') {
    log.info('Central DB initialized', {
      dialect: _db.dialect,
      target: config.url ? 'configured remote target' : config.path,
      role: options.role,
    });
  }
  return _db;
}

export interface InitTestDbOptions {
  fresh?: boolean;
}

/** For tests only — the installed composition owns backend selection/reset. */
export async function initTestDb(options: InitTestDbOptions = {}): Promise<DbDriver> {
  await closeDb();
  const db = await initDb(':memory:', { role: 'test' });
  if (db.prepareTestSchema) {
    await db.prepareTestSchema(options);
    await runMigrations(db, undefined, { mode: 'migrate' });
  }
  return db;
}

/** For tests that intentionally exercise SQLite-specific migrations or pragmas. */
export async function initSqliteTestDb(): Promise<DbDriver> {
  await closeDb();
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  _db = new SqliteDriver(raw);
  return _db;
}

export async function closeDb(): Promise<void> {
  const current = _db;
  _db = null;
  await current?.close();
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently.
 * Each driver owns the dialect-specific lookup and a positive-only cache;
 * creating a fresh test driver or closing the current driver resets it.
 */
export async function hasTable(db: DbDriver, name: string): Promise<boolean> {
  return db.hasTable(name);
}
