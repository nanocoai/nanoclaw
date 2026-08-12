import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Migration, ModuleMigration, ModuleMigrationName } from './index.js';

let closeCurrentDb: (() => void) | undefined;

afterEach(() => {
  closeCurrentDb?.();
  closeCurrentDb = undefined;
});

function testMigration(name: string, table = name.replace(/[^a-zA-Z0-9_]/g, '_'), version = 999): Migration {
  return {
    version,
    name,
    up(db) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
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
  const db = connection.initTestDb();
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

    registry.runMigrations(db);

    expect(db.prepare("SELECT name FROM schema_version WHERE name = 'module:test-owner:applied'").get()).toEqual({
      name: 'module:test-owner:applied',
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_module_applied'").get(),
    ).toEqual({ name: 'test_module_applied' });
  });

  it('preserves the explicit migration-list override', async () => {
    const registry = await freshRegistry();
    const db = await freshTestDb();
    const explicit = testMigration('test-explicit-only');
    registry.registerMigration(testModuleMigration('module:test-owner:not-selected', 'test_module_not_selected'));

    registry.runMigrations(db, [explicit]);

    expect(db.prepare('SELECT name FROM schema_version ORDER BY version').all()).toEqual([
      { name: 'test-explicit-only' },
    ]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_module_not_selected'").get(),
    ).toBeUndefined();
  });
});
