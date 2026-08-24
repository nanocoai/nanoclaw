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
