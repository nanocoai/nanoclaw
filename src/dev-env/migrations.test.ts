/**
 * The module migrations' PORTABILITY contract.
 *
 * `registry.test.ts` proves the registry behaves; this file proves it can be
 * INSTALLED — on SQLite and on a central DB that is not SQLite. That is a
 * separate property, and until it was written nothing anywhere asserted it:
 * every migration here was `sqliteOnly: true`, which `applyMigration` refuses
 * outright on any other dialect, and no backend baseline covers module
 * migrations (each generator seeds from the core `migrations` array while
 * `registerMigration` pushes into a private one). A PostgreSQL host therefore
 * had no route to these tables at all — `ncl stamps create` had nothing to
 * write to — and the failure surfaced only at boot, on a box.
 *
 * What the DATABASE half can prove here is SQLite's, because that is the
 * backend the trunk suite ships. The PostgreSQL half is proved two ways:
 * dialect behaviour against the recording drivers below (no server needed, so
 * these gate every bake that runs the unit suite), and the real thing
 * end-to-end against a live `postgres:17` — the transcript and the harness are
 * `skills/dev-env/POSTGRES-ACCEPTANCE.md` in the recipes repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getAgentGroup, initTestDb } from '../db/index.js';
import type { DbDialect, DbDriver, RunResult } from '../db/driver.js';
import { runMigrations, type Migration } from '../db/migrations/index.js';
import type { AgentGroup } from '../types.js';

import {
  claimantSessionMigration,
  devEnvMigration,
  envFailureReasonMigration,
  reservedOwnerRefMigration,
} from './db.js';
import { envExposuresDropEnvIndexMigration, envExposuresMigration } from './exposure.js';
// Side-effect: registers all seven dev-env migrations, so the default list
// `runMigrations` uses below is the one a host would actually apply.
import './index.js';
import { stampImagesMigration } from './stamp-images.js';
import { stampRegistryMigration } from './stamp-registry.js';

const DEV_ENV_MIGRATIONS: Migration[] = [
  devEnvMigration,
  reservedOwnerRefMigration,
  stampRegistryMigration,
  envFailureReasonMigration,
  claimantSessionMigration,
  stampImagesMigration,
  envExposuresMigration,
];

/**
 * A DbDriver that records the SQL it is handed and executes nothing. Enough to
 * ask each migration "what would you emit on THIS dialect?" without a server —
 * which is what lets the PostgreSQL spelling be gated by an ordinary bake.
 */
class RecordingDriver implements DbDriver {
  readonly execs: string[] = [];
  constructor(readonly dialect: DbDialect) {}
  async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  async all<T>(): Promise<T[]> {
    return [];
  }
  async run(): Promise<RunResult> {
    return { changes: 0 };
  }
  async exec(sql: string): Promise<void> {
    this.execs.push(sql);
  }
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async hasTable(): Promise<boolean> {
    return false;
  }
  async close(): Promise<void> {}
}

async function emitted(migration: Migration, dialect: DbDialect): Promise<string> {
  const driver = new RecordingDriver(dialect);
  await (migration as { up: (db: DbDriver) => Promise<void> }).up(driver);
  return driver.execs.join('\n');
}

describe('module migration portability', () => {
  it('registers no SQLite-only migration — the shape a PostgreSQL host refuses', () => {
    // The refusal is `applyMigration`'s: `Migration "…" is SQLite-only; port
    // it or provide a backend migration override`. It fires at deploy, on the
    // box, after a green compose. Assert the shape here instead.
    for (const migration of DEV_ENV_MIGRATIONS) {
      expect({ name: migration.name, sqliteOnly: migration.sqliteOnly }).toEqual({
        name: migration.name,
        sqliteOnly: undefined,
      });
    }
  });

  it('declares every integer column BIGINT — PostgreSQL INTEGER is int4 and a ms epoch overflows it', async () => {
    // `expires_at_ms` is the live hazard: ~1.79e12 into an int4 column is
    // `ERROR: integer out of range`, reachable ONLY on a `ttl` claim, because
    // `bound` and `pinned` write NULL there. Composes green, migrates green,
    // dies weeks later. The rule is applied to every integer column in the
    // module so nobody has to decide per column — and because
    // `schema-parity.test.ts` expects `bigint` for every SQLite INTEGER.
    for (const migration of DEV_ENV_MIGRATIONS) {
      const sql = await emitted(migration, 'postgres');
      expect({ name: migration.name, integers: /\bINTEGER\b/i.test(sql) }).toEqual({
        name: migration.name,
        integers: false,
      });
    }
  });

  it('keeps ONE partial unique index, on the name — and drops the env one on a box that has it', async () => {
    // THIS ASSERTED TWO INDEXES until the env one was removed, and the
    // inversion is the change rather than a relaxation: an env may hold several
    // grants now (a claimed child answers as its chat UI and its governance
    // dashboard at once), so uniqueness lives on the NAME, which is already the
    // ledger key and the future hostname.
    //
    // The WHERE is still load-bearing on the one that remains: without it,
    // "one LIVE grant per name" becomes "one grant EVER" and a revoked name is
    // never re-mintable.
    for (const dialect of ['sqlite', 'postgres'] as const) {
      const sql = await emitted(envExposuresMigration, dialect);
      expect(sql).toContain('CREATE UNIQUE INDEX idx_env_exposures_live_name ON env_exposures(name)');
      expect(sql).not.toContain('idx_env_exposures_live_env');
      expect(sql.match(/WHERE state IN \('pending','live'\)/g)?.length).toBe(1);

      // AND THE EXISTING BOX IS COVERED, which editing this migration in place
      // does not do: the runner selects pending migrations by NAME and keeps no
      // checksum, so a box that already applied this one never re-reads it and
      // would keep the index — its second exposure dying at the database with a
      // raw UNIQUE-constraint message and no remedy.
      const drop = await emitted(envExposuresDropEnvIndexMigration, dialect);
      expect(drop).toContain('DROP INDEX IF EXISTS idx_env_exposures_live_env;');
    }
  });
});

describe("the 'operator' reservation", () => {
  beforeEach(async () => {
    const db = await initTestDb();
    await runMigrations(db);
  });
  afterEach(async () => {
    await closeDb();
  });

  it('emits an inline SQLite trigger and a plpgsql function + trigger on PostgreSQL', async () => {
    const sqlite = await emitted(reservedOwnerRefMigration, 'sqlite');
    expect(sqlite).toContain('CREATE TRIGGER IF NOT EXISTS dev_env_reserved_group_id');
    expect(sqlite).toContain('RAISE(ABORT');

    const postgres = await emitted(reservedOwnerRefMigration, 'postgres');
    expect(postgres).toContain('CREATE OR REPLACE FUNCTION dev_env_reserved_group_id()');
    expect(postgres).toContain('RAISE EXCEPTION');
    // PostgreSQL has no CREATE TRIGGER IF NOT EXISTS — it is a syntax error —
    // and a bare CREATE fails "trigger already exists" on any re-run. DROP
    // first, so re-runnability is free.
    expect(postgres).not.toContain('CREATE TRIGGER IF NOT EXISTS');
    const drop = postgres.indexOf('DROP TRIGGER IF EXISTS dev_env_reserved_group_id ON agent_groups');
    const create = postgres.indexOf('CREATE TRIGGER dev_env_reserved_group_id');
    expect(drop).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it('THROWS on a dialect it has no spelling for, and emits nothing', async () => {
    // A no-op arm would be recorded in `schema_version` as APPLIED: a missing
    // security control reported as installed. The reservation cannot live in
    // `createAgentGroup` (recipe overlays replace that function wholesale at
    // compose), so the DB object is the only place it holds — and a dialect
    // this module cannot write it for must stop the deploy, loudly.
    const driver = new RecordingDriver('mysql');
    await expect(
      (reservedOwnerRefMigration as { up: (db: DbDriver) => Promise<void> }).up(driver),
    ).rejects.toThrow(/no 'operator' reservation for central DB dialect "mysql"/);
    expect(driver.execs).toEqual([]);
  });

  it('refuses the reserved id and admits an ordinary one, on the real SQLite schema', async () => {
    const group = (id: string): AgentGroup => ({
      id,
      name: id,
      folder: id,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    await expect(createAgentGroup(group('operator'))).rejects.toThrow(/reserved/);
    expect(await getAgentGroup('operator')).toBeUndefined();

    await createAgentGroup(group('ag-ordinary'));
    expect((await getAgentGroup('ag-ordinary'))?.id).toBe('ag-ordinary');
  });
});

describe('a ledger that already carries these names', () => {
  /**
   * The trap this guards: a PostgreSQL host whose schema was bootstrapped from
   * the frozen baseline gets `schema_version` seeded, and the host then boots
   * in `auto` mode — which resolves to VALIDATE on any non-SQLite dialect and
   * throws on anything pending. If an applied module migration were somehow
   * not counted as applied, every such host would refuse to boot with an error
   * naming `pnpm run migrate`, the one command whose import graph never
   * reaches the module barrels. Both modes must resolve quietly.
   */
  class LedgeredDriver extends RecordingDriver {
    constructor(
      dialect: DbDialect,
      private readonly applied: string[],
    ) {
      super(dialect);
    }
    override async hasTable(): Promise<boolean> {
      return true;
    }
    override async all<T>(): Promise<T[]> {
      return this.applied.map((name) => ({ name })) as T[];
    }
  }

  it('resolves in validate mode without re-running anything', async () => {
    const db = new LedgeredDriver(
      'postgres',
      DEV_ENV_MIGRATIONS.map((migration) => migration.name),
    );
    await expect(runMigrations(db, DEV_ENV_MIGRATIONS, { mode: 'validate' })).resolves.toBeUndefined();
    expect(db.execs).toEqual([]);
  });

  it('resolves in migrate mode without re-running anything', async () => {
    const db = new LedgeredDriver(
      'postgres',
      DEV_ENV_MIGRATIONS.map((migration) => migration.name),
    );
    await runMigrations(db, DEV_ENV_MIGRATIONS, { mode: 'migrate' });
    // The runner still ensures its own ledger table exists; what must NOT
    // happen is a second CREATE TABLE dev_envs.
    expect(db.execs.join('\n')).not.toContain('CREATE TABLE dev_envs');
  });

  it('refuses to boot when a name really is pending, naming it', async () => {
    const db = new LedgeredDriver('postgres', []);
    await expect(runMigrations(db, DEV_ENV_MIGRATIONS, { mode: 'validate' })).rejects.toThrow(
      /module:dev-env:envs/,
    );
  });
});
