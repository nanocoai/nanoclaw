import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectCentralDb } from './central-db-inspection.js';
import { closeDb } from '../src/db/connection.js';
import { quoteIdentifier, withPostgresTestEnvironment } from '../src/db/drivers/postgres/test-helpers.js';

const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';

afterEach(async () => {
  await closeDb();
});

describe.skipIf(!TEST_DB_URL)('PostgreSQL setup inspection', () => {
  it('reads live state through the installed composition', async () => {
    await withPostgresTestEnvironment('inspection', async ({ admin, schema }) => {
      const prefix = quoteIdentifier(schema);
      await admin.query(`
        CREATE TABLE ${prefix}.users (id text PRIMARY KEY, display_name text);
        CREATE TABLE ${prefix}.agent_groups (id text PRIMARY KEY);
        CREATE TABLE ${prefix}.messaging_group_agents (agent_group_id text NOT NULL);
        CREATE TABLE ${prefix}.container_configs (image_tag text);
        INSERT INTO ${prefix}.users VALUES ('cli:local', 'Ada');
        INSERT INTO ${prefix}.agent_groups VALUES ('ag-1'), ('ag-2');
        INSERT INTO ${prefix}.messaging_group_agents VALUES ('ag-1');
        INSERT INTO ${prefix}.container_configs VALUES ('derived'), (NULL);
      `);
      await expect(inspectCentralDb('/path/ignored/by-postgres')).resolves.toEqual({
        displayName: 'Ada',
        registeredGroups: 1,
        derivedGroups: 1,
      });
    });
  });

  it('does not turn a PostgreSQL connection failure into an empty install', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pg-inspection-failure-'));
    const passwordFile = path.join(dir, 'password');
    fs.writeFileSync(passwordFile, 'unused\n', { mode: 0o600 });
    const previous = {
      url: process.env.NANOCLAW_DB_URL,
      passwordFile: process.env.NANOCLAW_DB_PASSWORD_FILE,
      schema: process.env.NANOCLAW_DB_SCHEMA,
    };
    process.env.NANOCLAW_DB_URL = 'postgres://runtime@127.0.0.1:55999/nanoclaw_test_unreachable';
    process.env.NANOCLAW_DB_PASSWORD_FILE = passwordFile;
    process.env.NANOCLAW_DB_SCHEMA = 'nanoclaw';
    try {
      await expect(inspectCentralDb('/path/ignored/by-postgres')).rejects.toThrow(/ECONNREFUSED|timeout/i);
    } finally {
      if (previous.url === undefined) delete process.env.NANOCLAW_DB_URL;
      else process.env.NANOCLAW_DB_URL = previous.url;
      if (previous.passwordFile === undefined) delete process.env.NANOCLAW_DB_PASSWORD_FILE;
      else process.env.NANOCLAW_DB_PASSWORD_FILE = previous.passwordFile;
      if (previous.schema === undefined) delete process.env.NANOCLAW_DB_SCHEMA;
      else process.env.NANOCLAW_DB_SCHEMA = previous.schema;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
