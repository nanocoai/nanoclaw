import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

const db = await initDb(CENTRAL_DB_PATH, { role: 'migration' });

try {
  await runMigrations(db, undefined, { mode: 'migrate' });
  console.log('Central DB migrations are current.');
} finally {
  await closeDb();
}
