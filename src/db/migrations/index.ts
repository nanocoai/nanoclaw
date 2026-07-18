import type Database from 'better-sqlite3';

import { log } from '../../log.js';
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

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
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
];

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

export function runMigrations(db: Database.Database, list: Migration[] = migrations): void {
  db.exec(`
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
  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = list.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  log.info('Running migrations', { count: pending.length });

  for (const m of pending) {
    // Table recreates need FK enforcement off for the DROP+RENAME window.
    // The pragma must be toggled OUTSIDE the transaction (it's a silent
    // no-op inside one); foreign_key_check runs INSIDE so a violating
    // recreate rolls back atomically with nothing committed.
    if (m.disableForeignKeys) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        // Snapshot violations BEFORE up() runs: live DBs can carry latent
        // FK orphans (e.g. parents deleted through a FK-OFF sqlite3 CLI
        // session — ensureUserDm tolerates exactly this at runtime). The
        // migration must only fail for violations it INTRODUCED; throwing
        // on pre-existing ones would crash-loop the host at every boot
        // (runMigrations runs on startup) until manual DB surgery.
        const preexisting = m.disableForeignKeys
          ? new Set((db.pragma('foreign_key_check') as FkViolation[]).map(fkIdentity))
          : null;
        m.up(db);
        if (m.disableForeignKeys && preexisting) {
          const violations = db.pragma('foreign_key_check') as FkViolation[];
          const introduced = violations.filter((v) => !preexisting.has(fkIdentity(v)));
          const carried = violations.length - introduced.length;
          if (carried > 0) {
            log.warn('Pre-existing FK violations carried through migration (not introduced by it)', {
              migration: m.name,
              count: carried,
            });
          }
          if (introduced.length > 0) {
            throw new Error(`migration ${m.name} left FK violations: ${JSON.stringify(introduced.slice(0, 5))}`);
          }
        }
        const next = (
          db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number }
        ).v;
        db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
          next,
          m.name,
          new Date().toISOString(),
        );
      })();
    } finally {
      if (m.disableForeignKeys) db.pragma('foreign_keys = ON');
    }
    log.info('Migration applied', { name: m.name });
  }
}
