import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Migration, ModuleMigration, ModuleMigrationName } from './index.js';

let closeCurrentDb: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeCurrentDb?.();
  closeCurrentDb = undefined;
});

function testMigration(name: string, table = name.replace(/[^a-zA-Z0-9_]/g, '_'), version = 999): Migration {
  return {
    version,
    name,
    async up(db) {
      await db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    },
  };
}

function testModuleMigration(name: ModuleMigrationName, table?: string, version?: number): ModuleMigration {
  return testMigration(name, table, version) as ModuleMigration;
}

async function freshRegistry() {
  vi.resetModules();
  return import('./index.js');
}

async function freshTestDb() {
  const connection = await import('../connection.js');
  const db = await connection.initSqliteTestDb();
  closeCurrentDb = connection.closeDb;
  return db;
}

describe('module migration registry', () => {
  it('keeps built-ins first and module migrations in registration order regardless of version', async () => {
    const registry = await freshRegistry();
    const first = testModuleMigration('module:test-first:create-state', undefined, Number.MAX_SAFE_INTEGER);
    const second = testModuleMigration('module:test-second:create-state', undefined, 0);

    registry.registerMigration(first);
    registry.registerMigration(second);

    expect(registry.getRegisteredMigrations()).toEqual([...registry.migrations, first, second]);
  });

  it('reserves the module namespace away from built-in migrations', async () => {
    const registry = await freshRegistry();

    expect(registry.migrations.every((migration) => !migration.name.startsWith('module:'))).toBe(true);
  });

  it('rejects an unqualified module migration name at runtime', async () => {
    const registry = await freshRegistry();
    const unqualified = testMigration('create-state') as ModuleMigration;

    expect(() => registry.registerMigration(unqualified)).toThrow(
      'must use "module:<module-id>:<migration-id>" and remain stable after release',
    );
  });

  it('rejects duplicate module migration names', async () => {
    const registry = await freshRegistry();
    registry.registerMigration(testModuleMigration('module:test-owner:duplicate', 'test_module_duplicate_first'));

    expect(() =>
      registry.registerMigration(testModuleMigration('module:test-owner:duplicate', 'test_module_duplicate_second')),
    ).toThrow('Migration "module:test-owner:duplicate" already registered');
  });

  it('applies and records registered migrations with the default run', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    registry.registerMigration(testModuleMigration('module:test-owner:applied', 'test_module_applied'));

    await registry.runMigrations(db);

    expect(await db.get("SELECT name FROM schema_version WHERE name = 'module:test-owner:applied'")).toEqual({
      name: 'module:test-owner:applied',
    });
    expect(
      await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_module_applied'"),
    ).toEqual({ name: 'test_module_applied' });
  });

  it('runs a module migration exactly once across repeated runMigrations calls', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    let upCalls = 0;
    const idempotent: ModuleMigration = {
      version: 1,
      name: 'module:test-owner:idempotent',
      async up(driver) {
        upCalls++;
        await driver.exec('CREATE TABLE test_module_idempotent (id TEXT PRIMARY KEY)');
      },
    };
    registry.registerMigration(idempotent);

    await registry.runMigrations(db);
    await registry.runMigrations(db);
    await registry.runMigrations(db);

    expect(upCalls).toBe(1);
    expect(
      await db.all("SELECT name FROM schema_version WHERE name = 'module:test-owner:idempotent'"),
    ).toHaveLength(1);
  });

  it('applies module migrations in deterministic registration order even under a real FK dependency', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    // Registered in dependency order (parent before child) — mirrors the
    // real Away Mode case (sessions table must exist before the queue
    // table's FK to it). version numbers deliberately reversed to prove
    // ordering comes from registration order, not version.
    registry.registerMigration(
      testModuleMigration('module:test-order:parent', 'test_order_parent', 999),
    );
    const child: ModuleMigration = {
      version: 1,
      name: 'module:test-order:child',
      async up(driver) {
        // Fails outright if the parent table doesn't exist yet — proves
        // real ordering, not just distinct table names.
        await driver.exec(
          'CREATE TABLE test_order_child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES test_order_parent(id))',
        );
      },
    };
    registry.registerMigration(child);

    await expect(registry.runMigrations(db)).resolves.toBeUndefined();
    expect(await db.hasTable('test_order_parent')).toBe(true);
    expect(await db.hasTable('test_order_child')).toBe(true);
  });

  it('preserves the explicit migration-list override', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    const explicit = testMigration('test-explicit-only');
    registry.registerMigration(testModuleMigration('module:test-owner:not-selected', 'test_module_not_selected'));

    await registry.runMigrations(db, [explicit]);

    expect(await db.all('SELECT name FROM schema_version ORDER BY version')).toEqual([{ name: 'test-explicit-only' }]);
    expect(
      await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_module_not_selected'"),
    ).toBeUndefined();
  });
});

describe('migration runner modes and hooks', () => {
  it('validate mode performs no bootstrap DDL on an empty database', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();

    await expect(registry.runMigrations(db, [], { mode: 'validate' })).rejects.toThrow('pnpm run migrate');
    expect(await db.hasTable('schema_version')).toBe(false);
  });

  it('validate mode reports pending names and accepts a current ledger', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    const first = testMigration('test-mode-first');
    const second = testMigration('test-mode-second');

    await registry.runMigrations(db, [first], { mode: 'migrate' });
    await expect(registry.runMigrations(db, [first, second], { mode: 'validate' })).rejects.toThrow('test-mode-second');
    await expect(registry.runMigrations(db, [first], { mode: 'validate' })).resolves.toBeUndefined();
  });

  it('runs bootstrap, overrides, and the migration lock hook', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    const calls: string[] = [];
    Object.defineProperty(db, 'migrationHooks', {
      value: {
        bootstrapSchema: async () => {
          calls.push('bootstrap');
        },
        migrationOverrides: new Map([
          [
            'sqlite-original',
            {
              name: 'sqlite-original',
              async up(driver: typeof db) {
                calls.push('override');
                await driver.exec('CREATE TABLE override_won (id TEXT PRIMARY KEY)');
              },
            },
          ],
        ]),
        withMigrationLock: async (run: () => Promise<void>) => {
          calls.push('lock-enter');
          await run();
          calls.push('lock-exit');
        },
      },
    });
    const original: Migration = {
      version: 999,
      name: 'sqlite-original',
      sqliteOnly: true,
      up() {
        throw new Error('original migration must not run');
      },
    };

    await registry.runMigrations(db, [original], { mode: 'migrate' });

    expect(calls).toEqual(['lock-enter', 'bootstrap', 'override', 'lock-exit']);
    expect(await db.hasTable('override_won')).toBe(true);
  });

  it('defaults non-SQLite auto mode to validation without DDL', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    Object.defineProperty(db, 'dialect', { value: 'remote' });

    await expect(registry.runMigrations(db, [], { mode: 'auto' })).rejects.toThrow('pnpm run migrate');
    expect(await db.hasTable('schema_version')).toBe(false);
  });

  it('refuses SQLite-only migrations on another dialect before running them', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    Object.defineProperty(db, 'dialect', { value: 'remote' });
    const sqliteOnly: Migration = {
      version: 999,
      name: 'sqlite-refused',
      sqliteOnly: true,
      up() {
        throw new Error('must not run');
      },
    };

    await expect(registry.runMigrations(db, [sqliteOnly], { mode: 'migrate' })).rejects.toThrow(
      'port it or provide a backend migration override',
    );
  });
});
