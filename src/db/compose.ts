/** Open-source SQLite composition. A remote-backend skill replaces this file. */
import { registerDbDriver } from './driver-registry.js';
import { readPostgresEnvironment, selectPostgresUrl } from './drivers/postgres/config.js';
import { createPostgresDriver } from './drivers/postgres/index.js';

registerDbDriver(async (config, options) => {
  const environment = readPostgresEnvironment();
  const url = config.url || selectPostgresUrl(environment, options.role);
  if (url) return createPostgresDriver({ ...config, url }, options, environment);
  // SQLite is reachable but never EAGERLY loaded once PostgreSQL is composed:
  // the release bundle rewrites `better-sqlite3` here to the SEA-only loader,
  // so a static import is fatal in any plain-node consumer of the release tree.
  const [{ default: Database }, { default: fs }, { default: path }, { SqliteDriver }] = await Promise.all([
    import('better-sqlite3'),
    import('fs'),
    import('path'),
    import('./drivers/sqlite.js'),
  ]);
  if (options.readonly && !fs.existsSync(config.path)) {
    throw Object.assign(new Error(`SQLite central DB does not exist: ${config.path}`), { code: 'SQLITE_CANTOPEN' });
  }
  if (!options.readonly) fs.mkdirSync(path.dirname(config.path), { recursive: true });
  const raw = new Database(config.path, options.readonly ? { readonly: true, fileMustExist: true } : undefined);
  if (!options.readonly) raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  return new SqliteDriver(raw);
});
