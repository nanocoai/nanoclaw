import { log } from '../../log.js';
import type { ICentralDb } from '../central/types.js';
import { getCentralDbDialect } from '../connection.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';
import { migration010 } from './010-engage-modes.js';
import { migration011 } from './011-pending-sender-approvals.js';
import { migration012 } from './012-channel-registration.js';
import { migration013 } from './013-approval-render-metadata.js';
import { migration014 } from './014-container-configs.js';
import { migration015 } from './015-cli-scope.js';
import { moduleApprovalsPendingApprovals } from './module-approvals-pending-approvals.js';
import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';
import { hasIndex, type MigrationContext } from './helpers.js';

export type { MigrationContext } from './helpers.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: ICentralDb, ctx: MigrationContext) => void;
}

const migrations: Migration[] = [
  migration001,
  migration002,
  moduleApprovalsPendingApprovals,
  moduleAgentToAgentDestinations,
  moduleApprovalsTitleOptions,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
];

export function runMigrations(db: ICentralDb): void {
  const ctx: MigrationContext = { dialect: db.dialect };

  execDialectBootstrap(db, ctx);

  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  log.info('Running migrations', { count: pending.length, dialect: ctx.dialect });

  for (const m of pending) {
    db.transaction(() => {
      m.up(db, ctx);
      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        m.name,
        new Date().toISOString(),
      );
    });
    log.info('Migration applied', { name: m.name });
  }
}

function execDialectBootstrap(db: ICentralDb, ctx: MigrationContext): void {
  if (ctx.dialect === 'mysql') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INT PRIMARY KEY,
        name    VARCHAR(255) NOT NULL,
        applied VARCHAR(64) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    if (!hasIndex(db, ctx, 'schema_version', 'idx_schema_version_name')) {
      db.exec(`CREATE UNIQUE INDEX idx_schema_version_name ON schema_version(name)`);
    }
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        applied TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
    `);
  }
}

/** @internal — dialect for tests that call runMigrations without a full ICentralDb mock */
export function migrationDialect(): MigrationContext['dialect'] {
  return getCentralDbDialect();
}
