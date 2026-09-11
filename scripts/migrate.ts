import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { getRegisteredMigrations, runMigrations } from '../src/db/migrations/index.js';
// Side-effect import: every module that contributes migrations, in the one
// graph this process and the host share. Without it a module migration is
// invisible HERE and pending THERE — which on a dialect where 'auto' means
// validate is `exit 1` at boot, right after this script said the DB was current.
import '../src/db/migrations/registered-modules.js';

const db = await initDb(CENTRAL_DB_PATH, { role: 'migration' });

try {
  // NAMED, not merely applied. A module migration is contributed by an
  // installed composition rather than by the trunk barrel, so the operator's
  // deploy transcript is the only place its identity is ever written down.
  const modules = getRegisteredMigrations().filter((migration) => migration.name.startsWith('module:'));
  console.log(
    modules.length > 0
      ? `Module migrations registered: ${modules.map((migration) => migration.name).join(', ')}`
      : 'No module migrations are registered in this composition.',
  );
  await runMigrations(db, undefined, { mode: 'migrate' });
  console.log('Central DB migrations are current.');
} finally {
  await closeDb();
}
