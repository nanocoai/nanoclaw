// Separate migration caller for the cross-process SQLite regression.
import Database from 'better-sqlite3';

import { SqliteDriver } from '../../drivers/sqlite.js';
import { runMigrations } from '../index.js';

const raw = new Database(process.argv[2]);
raw.pragma('journal_mode = WAL');
const db = new SqliteDriver(raw);

try {
  await runMigrations(db);
} finally {
  await db.close();
}
