import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { Migration } from '../../migrations/index.js';
import { runMigrations } from '../../migrations/index.js';
import type { PostgresDbConfig } from './config.js';
import { PostgresDriver } from './index.js';

const { Client } = pg;
const TEST_DB_URL = process.env.NANOCLAW_TEST_DB_URL || '';

function testConfig(schema: string, hostLock = false): PostgresDbConfig {
  return {
    path: '',
    url: TEST_DB_URL,
    migrateUrl: '',
    schema,
    passwordFile: '',
    statementTimeoutMs: 30_000,
    hostLock,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!TEST_DB_URL)('PostgreSQL process coordination', () => {
  it('fails quickly and clearly when PostgreSQL is unreachable at boot', async () => {
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pg-down-'));
    const passwordFile = path.join(secretDir, 'password');
    fs.writeFileSync(passwordFile, 'unused\n', { mode: 0o600 });
    const startedAt = Date.now();

    try {
      await expect(
        PostgresDriver.create(
          {
            ...testConfig('nanoclaw'),
            url: 'postgres://postgres@127.0.0.1:55999/nanoclaw_test_unreachable',
            passwordFile,
          },
          { role: 'host' },
        ),
      ).rejects.toThrow(/ECONNREFUSED|timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    } finally {
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('rejects a configured schema the runtime role cannot access', async () => {
    const schema = `nc_test_inaccessible_${process.pid}`;
    const role = `nc_test_runtime_${process.pid}`;
    const parsed = new URL(TEST_DB_URL);
    parsed.username = role;
    parsed.password = '';
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pg-schema-access-'));
    const passwordFile = path.join(secretDir, 'password');
    fs.writeFileSync(passwordFile, 'schema-test\n', { mode: 0o600 });
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'schema-test'`);
    await admin.query(`CREATE SCHEMA "${schema}"`);

    try {
      await expect(
        PostgresDriver.create({ ...testConfig(schema), url: parsed.toString(), passwordFile }, { role: 'runtime' }),
      ).rejects.toThrow(/schema.*access|current schema/i);
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('rejects an ICU-provider database even when datcollate reports C', async () => {
    const database = `nanoclaw_test_icu_${process.pid}`;
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'C' LOCALE 'C'`);
    const url = new URL(TEST_DB_URL);
    url.pathname = `/${database}`;

    try {
      await expect(
        PostgresDriver.create(
          { ...testConfig(`nc_test_icu_schema_${process.pid}`), url: url.toString() },
          { role: 'test' },
        ),
      ).rejects.toThrow(/locale provider|libc/i);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it('serializes concurrent migration runners on a fresh schema', async () => {
    const schema = `nc_test_migration_lock_${process.pid}`;
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

    const first = await PostgresDriver.create(testConfig(schema), { role: 'test' });
    const second = await PostgresDriver.create(testConfig(schema), { role: 'test' });
    const migration: Migration = {
      version: 1,
      name: 'postgres-concurrent-migration-test',
      async up(db) {
        await db.exec('CREATE TABLE postgres_migration_probe (id text PRIMARY KEY)');
        await db.run('INSERT INTO postgres_migration_probe (id) VALUES (?)', 'only-once');
      },
    };

    try {
      await Promise.all([
        runMigrations(first, [migration], { mode: 'migrate' }),
        runMigrations(second, [migration], { mode: 'migrate' }),
      ]);
      expect(
        (await first.get<{ count: number }>('SELECT COUNT(*) AS count FROM postgres_migration_probe'))?.count,
      ).toBe(1);
      expect(
        (
          await first.get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM schema_version WHERE name = ?',
            migration.name,
          )
        )?.count,
      ).toBe(1);
    } finally {
      await first.close();
      await second.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('does not apply the normal transaction watchdog to a complete migration run', async () => {
    const schema = `nc_test_migration_watchdog_${process.pid}`;
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const driver = await PostgresDriver.create(testConfig(schema), { role: 'test' }, 25);
    const migration: Migration = {
      version: 1,
      name: 'postgres-slow-migration-test',
      async up(db) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await db.exec('CREATE TABLE postgres_slow_migration_probe (id text PRIMARY KEY)');
      },
    };

    try {
      await expect(runMigrations(driver, [migration], { mode: 'migrate' })).resolves.toBeUndefined();
      expect(await driver.hasTable('postgres_slow_migration_probe')).toBe(true);
    } finally {
      await driver.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('waits for the migration advisory lock beyond the normal lock timeout', async () => {
    const schema = `nc_test_migration_wait_${process.pid}`;
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const first = await PostgresDriver.create(testConfig(schema), { role: 'test' });
    const second = await PostgresDriver.create(testConfig(schema), { role: 'test' });
    const firstLocked = deferred();
    const releaseFirst = deferred();

    try {
      const holding = first.migrationHooks!.withMigrationLock!(async () => {
        firstLocked.resolve();
        await releaseFirst.promise;
      });
      await firstLocked.promise;
      let secondEntered = false;
      const waiting = second.migrationHooks!.withMigrationLock!(async () => {
        secondEntered = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 5_250));
      expect(secondEntered).toBe(false);
      releaseFirst.resolve();
      await holding;
      await expect(waiting).resolves.toBeUndefined();
      expect(secondEntered).toBe(true);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first.close(), second.close()]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }, 10_000);

  it('provisions one fresh schema safely across concurrent drivers', async () => {
    const schema = `nc_test_schema_create_${process.pid}`;
    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const drivers: PostgresDriver[] = [];

    try {
      drivers.push(
        ...(await Promise.all(
          Array.from({ length: 8 }, () => PostgresDriver.create(testConfig(schema), { role: 'test' })),
        )),
      );
      expect(drivers).toHaveLength(8);
    } finally {
      await Promise.allSettled(drivers.map((driver) => driver.close()));
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it('holds the singleton host lock until clean shutdown', async () => {
    const schema = `nc_test_host_lock_${process.pid}`;
    const parsed = new URL(TEST_DB_URL);
    const password = decodeURIComponent(parsed.password);
    if (!password) throw new Error('Host-lock integration test requires a password in NANOCLAW_TEST_DB_URL');
    parsed.password = '';

    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-lock-'));
    const passwordFile = path.join(secretDir, 'password');
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });

    const admin = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}"`);
    const driver = await PostgresDriver.create(
      { ...testConfig(schema, true), url: parsed.toString(), passwordFile },
      { role: 'host' },
    );

    try {
      const whileRunning = await admin.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired`,
        ['nanoclaw:host', schema],
      );
      expect(whileRunning.rows[0]?.acquired).toBe(false);

      const holder = await admin.query<{ pid: number }>(
        `SELECT activity.pid
           FROM pg_locks locks
           JOIN pg_stat_activity activity ON activity.pid = locks.pid
          WHERE locks.locktype = 'advisory'
            AND locks.granted
            AND activity.application_name = 'nanoclaw-host'`,
      );
      const originalPid = holder.rows[0]?.pid;
      expect(originalPid).toBeDefined();
      await admin.query('SELECT pg_terminate_backend($1)', [originalPid]);

      await vi.waitFor(
        async () => {
          const recovered = await admin.query<{ pid: number }>(
            `SELECT activity.pid
               FROM pg_locks locks
               JOIN pg_stat_activity activity ON activity.pid = locks.pid
              WHERE locks.locktype = 'advisory'
                AND locks.granted
                AND activity.application_name = 'nanoclaw-host'`,
          );
          expect(recovered.rows.some(({ pid }) => pid !== originalPid)).toBe(true);
        },
        { timeout: 3_000, interval: 25 },
      );
      expect((await driver.get<{ value: number }>('SELECT 1 AS value'))?.value).toBe(1);

      const idle = await admin.query<{ pid: number }>(
        `SELECT activity.pid
           FROM pg_stat_activity activity
          WHERE activity.application_name = 'nanoclaw-host'
            AND NOT EXISTS (
              SELECT 1
                FROM pg_locks locks
               WHERE locks.pid = activity.pid
                 AND locks.locktype = 'advisory'
                 AND locks.granted
            )`,
      );
      expect(idle.rows[0]?.pid).toBeDefined();
      await admin.query('SELECT pg_terminate_backend($1)', [idle.rows[0]!.pid]);
      await vi.waitFor(
        async () => {
          expect((await driver.get<{ value: number }>('SELECT 1 AS value'))?.value).toBe(1);
        },
        { timeout: 3_000, interval: 25 },
      );

      await driver.close();

      const afterShutdown = await admin.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired`,
        ['nanoclaw:host', schema],
      );
      expect(afterShutdown.rows[0]?.acquired).toBe(true);
      await admin.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, ['nanoclaw:host', schema]);
    } finally {
      await driver.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('exits rather than continuing when a lost host lock is acquired elsewhere', async () => {
    const schema = `nc_test_host_lock_failure_${process.pid}`;
    const parsed = new URL(TEST_DB_URL);
    const password = decodeURIComponent(parsed.password);
    if (!password) throw new Error('Host-lock integration test requires a password in NANOCLAW_TEST_DB_URL');
    parsed.password = '';

    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-host-lock-failure-'));
    const passwordFile = path.join(secretDir, 'password');
    fs.writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });

    const admin = new Client({ connectionString: TEST_DB_URL });
    const contender = new Client({ connectionString: TEST_DB_URL });
    await admin.connect();
    await contender.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE; CREATE SCHEMA "${schema}"`);
    const driver = await PostgresDriver.create(
      { ...testConfig(schema, true), url: parsed.toString(), passwordFile },
      { role: 'host' },
    );
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      const holder = await admin.query<{ pid: number }>(
        `SELECT activity.pid
             FROM pg_locks locks
             JOIN pg_stat_activity activity ON activity.pid = locks.pid
            WHERE locks.locktype = 'advisory'
              AND locks.granted
              AND activity.application_name = 'nanoclaw-host'`,
      );
      const originalPid = holder.rows[0]?.pid;
      expect(originalPid).toBeDefined();

      const contenderPid = (await contender.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      expect(contenderPid).toBeDefined();
      const contenderLock = contender.query(`SELECT pg_advisory_lock(hashtext($1), hashtext($2))`, [
        'nanoclaw:host',
        schema,
      ]);
      await vi.waitFor(async () => {
        const waiting = await admin.query<{ count: number }>(
          `SELECT COUNT(*) AS count
               FROM pg_locks
              WHERE pid = $1
                AND locktype = 'advisory'
                AND NOT granted`,
          [contenderPid],
        );
        expect(waiting.rows[0]?.count).toBe(1);
      });

      await admin.query('SELECT pg_terminate_backend($1)', [originalPid]);
      await contenderLock;

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), {
        timeout: 12_000,
        interval: 100,
      });
      await expect(driver.get('SELECT 1')).rejects.toThrow('host lock is not held');
      await contender.query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, ['nanoclaw:host', schema]);
    } finally {
      exit.mockRestore();
      await driver.close();
      await contender.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      fs.rmSync(secretDir, { recursive: true, force: true });
    }
  }, 15_000);
});
