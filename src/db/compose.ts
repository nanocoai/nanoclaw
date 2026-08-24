/** Open-source SQLite composition. A remote-backend skill replaces this file. */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { registerDbDriver } from './driver-registry.js';
import { SqliteDriver } from './drivers/sqlite.js';

registerDbDriver((config, options) => {
  if (config.url) {
    throw new Error('A remote central-DB target was provided, but no remote backend is installed');
  }
  if (options.readonly && !fs.existsSync(config.path)) {
    throw Object.assign(new Error(`SQLite central DB does not exist: ${config.path}`), { code: 'SQLITE_CANTOPEN' });
  }
  if (!options.readonly) fs.mkdirSync(path.dirname(config.path), { recursive: true });
  const raw = new Database(config.path, options.readonly ? { readonly: true, fileMustExist: true } : undefined);
  if (!options.readonly) raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  return new SqliteDriver(raw);
});
