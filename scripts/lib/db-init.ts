/**
 * scripts/lib/db-init.ts — shared DB-init boilerplate for operator
 * scripts. Resolves the central DB path from DATA_DIR, initializes the
 * connection, and runs migrations. Idempotent: safe to call once per
 * script invocation.
 */
import path from 'path';

import { DATA_DIR } from '../../src/config.js';
import { initDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrations/index.js';

export function initOperatorDb(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
}
