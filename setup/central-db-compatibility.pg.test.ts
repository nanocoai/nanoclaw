import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initDb } from '../src/db/connection.js';
import { quoteIdentifier, withPostgresTestEnvironment } from '../src/db/drivers/postgres/test-helpers.js';

const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';

afterEach(async () => {
  await closeDb();
});

describe.skipIf(!TEST_DB_URL)('PostgreSQL central DB composition', () => {
  it('selects the installed PostgreSQL driver and enforces read-only inspection', async () => {
    await withPostgresTestEnvironment('composition', async ({ admin, schema }) => {
      await admin.query(`CREATE TABLE ${quoteIdentifier(schema)}.probe (id text PRIMARY KEY)`);
      const db = await initDb(':memory:', { role: 'tool', readonly: true });
      expect(db.dialect).toBe('postgres');
      await expect(db.run('INSERT INTO probe (id) VALUES (?)', 'blocked')).rejects.toMatchObject({ code: '25006' });
    });
  });
});
