import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { quoteIdentifier, withPostgresTestEnvironment } from '../src/db/drivers/postgres/test-helpers.js';

const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';
const ROOT = path.resolve(import.meta.dirname, '..');

describe.skipIf(!TEST_DB_URL)('scripts/q.ts PostgreSQL routing', () => {
  it('routes only the canonical central path to PostgreSQL without creating SQLite', async () => {
    await withPostgresTestEnvironment('q', async ({ admin, schema }) => {
      const prefix = quoteIdentifier(schema);
      await admin.query(`CREATE TABLE ${prefix}.probe (id text PRIMARY KEY)`);
      await admin.query(`INSERT INTO ${prefix}.probe VALUES ('one'), ('two')`);
      const localDb = path.join(ROOT, 'data', 'v2.db');
      const existed = fs.existsSync(localDb);
      const before = existed ? fs.statSync(localDb).mtimeMs : null;

      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/q.ts', 'data/v2.db', 'SELECT COUNT(*) AS n FROM probe'],
        { cwd: ROOT, env: process.env, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('2');
      expect(fs.existsSync(localDb)).toBe(existed);
      if (before !== null) expect(fs.statSync(localDb).mtimeMs).toBe(before);
    });
  });
});
