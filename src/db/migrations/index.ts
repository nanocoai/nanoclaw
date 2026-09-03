import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { DbDriver } from '../driver.js';
import { sqliteRaw } from '../drivers/sqlite.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';
import { migration017 } from './017-agent-message-policies.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';
import { migration010 } from './010-engage-modes.js';
import { migration011 } from './011-pending-sender-approvals.js';
import { migration012 } from './012-channel-registration.js';
import { migration013 } from './013-approval-render-metadata.js';
import { migration014 } from './014-container-configs.js';
import { migration015 } from './015-cli-scope.js';
import { migration016 } from './016-messaging-group-instance.js';
import { moduleApprovalsPendingApprovals } from './module-approvals-pending-approvals.js';
import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';
import { migration018 } from './018-approvals-approver-user-id.js';
import { migration019 } from './019-wiring-threads.js';
import { migration020 } from './020-container-config-timezone.js';
import { migration021 } from './021-approval-question.js';
import { migration022 } from './022-messaging-group-detached.js';
import { migration023 } from './023-approvals-instance.js';
import { migration024 } from './024-host-coordination.js';

interface MigrationBase {
  version: number;
  /** Permanent applied identity. Never rename a migration after release. */
  name: string;
  /**
   * Run with foreign_keys=OFF. Required for table recreates (SQLite can't
   * drop a table-level UNIQUE without DROP+RENAME, and DROP fails FK
   * integrity when child rows exist — see migration 011's header).
   * PRAGMA foreign_keys is a no-op inside a transaction, so the runner
   * toggles it around the transaction and runs PRAGMA foreign_key_check
   * inside it, so violations roll the migration back.
   */
  disableForeignKeys?: boolean;
}

export interface PortableMigration extends MigrationBase {
  sqliteOnly?: false;
  up: (db: DbDriver) => void | Promise<void>;
}

export interface SqliteOnlyMigration extends MigrationBase {
  sqliteOnly: true;
  up: (db: Database.Database) => void | Promise<void>;
}

export type Migration = PortableMigration | SqliteOnlyMigration;

export type MigrationMode = 'auto' | 'validate' | 'migrate';

export interface MigrationRunOptions {
  mode?: MigrationMode;
}

/**
 * Public module migrations use a core-reserved, owner-qualified identity so
 * independent modules may reuse local migration names without colliding.
 */
export type ModuleMigrationName = `module:${string}:${string}`;
export type ModuleMigration = (Omit<PortableMigration, 'name'> | Omit<SqliteOnlyMigration, 'name'>) & {
  name: ModuleMigrationName;
};

export const migrations: Migration[] = [
  migration001,
  migration002,
  moduleApprovalsPendingApprovals,
  moduleAgentToAgentDestinations,
  migration017,
  moduleApprovalsTitleOptions,
  migration018,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
];

/**
 * Migrations contributed by self-registering modules.
 *
 * When multiple migrations are pending, built-in migrations run first. Module
 * migrations are not interleaved with built-ins by `version`; they follow the
 * deterministic import order of their owning modules because the modules
 * barrel uses explicit side-effect imports.
 */
const moduleMigrations: Migration[] = [];
const MODULE_MIGRATION_NAME_RE = /^module:[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;

export function registerMigration(migration: ModuleMigration): void {
  if (!MODULE_MIGRATION_NAME_RE.test(migration.name)) {
    throw new Error(
      `Module migration "${migration.name}" must use "module:<module-id>:<migration-id>" and remain stable after release`,
    );
  }
  if ([...migrations, ...moduleMigrations].some((candidate) => candidate.name === migration.name)) {
    throw new Error(`Migration "${migration.name}" already registered`);
  }
  moduleMigrations.push(migration);
}

export function getRegisteredMigrations(): readonly Migration[] {
  return [...migrations, ...moduleMigrations];
}

/** Row shape of PRAGMA foreign_key_check. Child rowids are stable across a
 *  parent-table recreate (child tables aren't touched), so this JSON identity
 *  is a reliable before/after diff key. */
interface FkViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

const fkIdentity = (v: FkViolation): string =>
  JSON.stringify({ table: v.table, rowid: v.rowid, parent: v.parent, fkid: v.fkid });

export async function runMigrations(
  db: DbDriver,
  list: readonly Migration[] = getRegisteredMigrations(),
  options: MigrationRunOptions = {},
): Promise<void> {
  const mode =
    options.mode === undefined || options.mode === 'auto'
      ? db.dialect === 'sqlite'
        ? 'migrate'
        : 'validate'
      : options.mode;

  if (mode === 'validate') {
    if (!(await db.hasTable('schema_version'))) {
      throw new Error('Central DB schema is not initialized; run `pnpm run migrate` with the migration role');
    }
    const applied = new Set((await db.all<{ name: string }>('SELECT name FROM schema_version')).map((row) => row.name));
    const pending = list.filter((migration) => !applied.has(migration.name));
    if (pending.length > 0) {
      throw new Error(
        `Central DB has pending migrations (${pending.map((migration) => migration.name).join(', ')}); run \`pnpm run migrate\``,
      );
    }
    return;
  }

  const migrate = async (): Promise<void> => {
    await db.migrationHooks?.bootstrapSchema?.(db);
    await db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        applied TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
    `);

    // Uniqueness is keyed on `name`, not `version`. This lets module
    // migrations (added later by install skills) pick arbitrary version
    // numbers without coordinating across modules. `version` stays on
    // the Migration object as an ordering hint within the barrel array;
    // the stored `version` column is auto-assigned at insert time as an
    // applied-order number.
    const applied = new Set((await db.all<{ name: string }>('SELECT name FROM schema_version')).map((row) => row.name));
    const pending = list.filter((migration) => !applied.has(migration.name));
    if (pending.length === 0) return;

    log.info('Running migrations', { count: pending.length });
    for (const migration of pending) await applyMigration(db, migration);
  };

  if (db.migrationHooks?.withMigrationLock) await db.migrationHooks.withMigrationLock(migrate);
  else await migrate();
}

async function applyMigration(db: DbDriver, migration: Migration): Promise<void> {
  const override = db.migrationHooks?.migrationOverrides?.get(migration.name);
  const sqliteOnly = override ? false : migration.sqliteOnly === true;
  const disableForeignKeys = override ? false : migration.disableForeignKeys === true;
  if ((sqliteOnly || disableForeignKeys) && db.dialect !== 'sqlite') {
    throw new Error(`Migration "${migration.name}" is SQLite-only; port it or provide a backend migration override`);
  }

  const raw = sqliteOnly || disableForeignKeys ? sqliteRaw(db) : null;
  // Table recreates need FK enforcement off for the DROP+RENAME window.
  // The pragma must be toggled OUTSIDE the transaction (it's a silent
  // no-op inside one); foreign_key_check runs INSIDE so a violating
  // recreate rolls back atomically with nothing committed.
  if (disableForeignKeys) raw!.pragma('foreign_keys = OFF');
  try {
    await db.transaction(async () => {
      // Snapshot violations BEFORE up() runs: live DBs can carry latent
      // FK orphans. A migration must fail only for violations it introduces.
      const preexisting = disableForeignKeys
        ? new Set((raw!.pragma('foreign_key_check') as FkViolation[]).map(fkIdentity))
        : null;
      if (override) await override.up(db);
      else if (migration.sqliteOnly) await migration.up(raw!);
      else await migration.up(db);
      if (disableForeignKeys && preexisting) {
        const violations = raw!.pragma('foreign_key_check') as FkViolation[];
        const introduced = violations.filter((violation) => !preexisting.has(fkIdentity(violation)));
        const carried = violations.length - introduced.length;
        if (carried > 0) {
          log.warn('Pre-existing FK violations carried through migration (not introduced by it)', {
            migration: migration.name,
            count: carried,
          });
        }
        if (introduced.length > 0) {
          throw new Error(`migration ${migration.name} left FK violations: ${JSON.stringify(introduced.slice(0, 5))}`);
        }
      }
      const next = (await db.get<{ v: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version'))!.v;
      await db.run(
        'INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)',
        next,
        migration.name,
        new Date().toISOString(),
      );
    });
  } finally {
    if (disableForeignKeys) raw!.pragma('foreign_keys = ON');
  }
  log.info('Migration applied', { name: migration.name });
}
