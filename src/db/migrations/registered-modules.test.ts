/**
 * The two halves of the module-migration deploy gap, guarded.
 *
 * The LOUD half is trunk's already: on a dialect where 'auto' resolves to
 * validate, a pending module migration throws at boot. The SILENT half — a
 * module registering into the host's graph and not into the migrate step's —
 * had nothing watching it, and it is the half that decides whether the loud
 * one ever fires. The first two tests are that watch, on file text, because a
 * missing side-effect import is invisible to a type checker and to every test
 * that imports the module it forgot.
 *
 * The third test is the failure itself, end to end, against a driver that says
 * it is not SQLite: pending under 'auto', applied by the deploy's explicit
 * migrate run, current under 'auto' afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Migration, ModuleMigration, ModuleMigrationName } from './index.js';

/** `<tree>/src` — this file lives at `<tree>/src/db/migrations/`. */
const SRC = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATIONS_DIR = path.join(SRC, 'db', 'migrations');
const BARREL = path.join(MIGRATIONS_DIR, 'registered-modules.ts');

let closeCurrentDb: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeCurrentDb?.();
  closeCurrentDb = undefined;
});

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** The first path segment under `src/` — the unit a side-effect import names. */
function moduleRoot(file: string): string {
  return path.relative(SRC, file).split(path.sep)[0]!;
}

describe('the migrate step and the host share one module-registration graph', () => {
  it('names every module that registers a migration', () => {
    // The registry DEFINES registerMigration; an importer that never calls it
    // registers nothing. Both are excluded by the call-shape match, and the
    // registry is excluded by name so a future re-export cannot smuggle it in.
    const callers = tsFiles(SRC)
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) => file !== path.join(MIGRATIONS_DIR, 'index.ts'))
      .filter((file) => /(^|[^\w.])registerMigration\s*\(/.test(fs.readFileSync(file, 'utf8')));

    const barrel = fs.readFileSync(BARREL, 'utf8');
    const imported = new Set(
      [...barrel.matchAll(/^import\s+'([^']+)';$/gm)].map((match) =>
        moduleRoot(path.resolve(MIGRATIONS_DIR, match[1]!)),
      ),
    );

    const unreached = [...new Set(callers.map(moduleRoot))].filter((root) => !imported.has(root)).sort();
    expect(
      unreached,
      `src/${unreached.join(', src/')} register migrations that src/db/migrations/registered-modules.ts never imports. ` +
        'The host would register them at boot and the deploy\'s migrate step would not, which is a crash loop on any ' +
        'dialect where migration mode "auto" means validate.',
    ).toEqual([]);
  });

  it('keeps the migrate script on that barrel', () => {
    expect(fs.readFileSync(path.join(SRC, '..', 'scripts', 'migrate.ts'), 'utf8')).toContain(
      "import '../src/db/migrations/registered-modules.js';",
    );
  });

  it('keeps the append marker region a module registers into', () => {
    // Every module appends with `at:module-registrations`, whose engine arm
    // REFUSES a missing region. The markerless arm would instead CREATE this
    // file, so a composition that dropped this skill would compose green
    // carrying a barrel nothing imports and exit 1 at boot on a validate
    // dialect. Deleting the region converts that loud refusal back into the
    // silent create, which is why it is pinned here and not merely commented.
    const barrel = fs.readFileSync(BARREL, 'utf8');
    expect(barrel, 'the opening marker a module appends into').toContain('// >>> module-registrations');
    expect(barrel, 'the closing marker the engine inserts before').toContain('// <<< module-registrations');
  });
});

describe('a module migration on a validate dialect', () => {
  function testModuleMigration(name: ModuleMigrationName, table: string): ModuleMigration {
    return {
      version: 999,
      name,
      async up(db) {
        await db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
      },
    } as ModuleMigration;
  }

  it('is pending until the deploy step that reaches it applies it', async () => {
    vi.resetModules();
    const registry = await import('./index.js');
    const connection = await import('../connection.js');
    const db = await connection.initSqliteTestDb();
    closeCurrentDb = connection.closeDb;
    // The SQLite driver, saying what a PostgreSQL one says. Nothing else about
    // this database changes: the point is the MODE the dialect selects.
    Object.defineProperty(db, 'dialect', { value: 'postgres', configurable: true });

    const core: Migration = {
      version: 1,
      name: 'test-deploy-core',
      async up(driver) {
        await driver.exec('CREATE TABLE test_deploy_core (id TEXT PRIMARY KEY)');
      },
    };
    const module = testModuleMigration('module:test-deploy:applied', 'test_deploy_module');

    // The migrate step as it ran BEFORE this seam: the module is not in its graph.
    await registry.runMigrations(db, [core], { mode: 'migrate' });

    // The host boots, imports the module barrel, and validates.
    await expect(registry.runMigrations(db, [core, module])).rejects.toThrow('module:test-deploy:applied');

    // The migrate step WITH the module in its graph, then the same boot.
    await registry.runMigrations(db, [core, module], { mode: 'migrate' });
    await expect(registry.runMigrations(db, [core, module])).resolves.toBeUndefined();
    expect(await db.get("SELECT name FROM schema_version WHERE name = 'module:test-deploy:applied'")).toEqual({
      name: 'module:test-deploy:applied',
    });
  });
});
