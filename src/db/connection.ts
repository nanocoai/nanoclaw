import fs from 'fs';
import path from 'path';

import { CENTRAL_DB_BACKEND, getSeekDbCentralDbOptions } from '../config.js';
import { createCentralDb } from './central/factory.js';
import { ensureSeekDbDatabase, shutdownSeekDbWorker } from './central/seekdb.js';
import type { CentralDbDialect, ICentralDb } from './central/types.js';

let _db: ICentralDb | null = null;

export function getDb(): ICentralDb {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export function getCentralDbDialect(): CentralDbDialect {
  return getDb().dialect;
}

export function initDb(dbPath: string): ICentralDb {
  if (CENTRAL_DB_BACKEND === 'seekdb') {
    _db = createCentralDb('seekdb', getSeekDbCentralDbOptions());
    return _db;
  }

  _db = createCentralDb('sqlite', { path: dbPath });
  return _db;
}

/** For tests only — creates a fresh in-memory central DB. */
export function initTestDb(): ICentralDb {
  _db = createCentralDb('sqlite', { path: ':memory:', memory: true });
  return _db;
}

/** For SeekDB integration tests only — wires getDb() to an existing central handle. */
export function setCentralDbForTest(db: ICentralDb): void {
  _db = db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
  shutdownSeekDbWorker();
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising errors.
 */
export function hasTable(db: ICentralDb, name: string): boolean {
  const dialect = db.dialect;
  if (dialect === 'sqlite') {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(name) as
      | { '1': number }
      | undefined;
    return row !== undefined;
  }
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?
       LIMIT 1`,
    )
    .get(name) as { ok: number } | undefined;
  return row !== undefined;
}

/** Ensure the central database exists. SQLite: create data/ dir. SeekDB: create logical DB. */
export function ensureCentralDatabaseExists(dbPath: string): void {
  if (CENTRAL_DB_BACKEND !== 'seekdb') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    return;
  }

  const options = getSeekDbCentralDbOptions();
  if (options.mode === 'embedded') {
    fs.mkdirSync(path.dirname(options.path!), { recursive: true });
  }
  ensureSeekDbDatabase(options);
}
