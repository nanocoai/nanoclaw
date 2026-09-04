import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * pr_threads, v2 shape (owned by the pr-factory-core component).
 *
 * Fresh installs: creates the table without a bot identity column — the
 * delivering bot is resolved per messaging group via
 * `messaging_groups.instance`, so pr_threads never needs to record it.
 *
 * Fork upgrades: installs that ran the earlier pr-factory substrate carry a
 * `bot_id` column on pr_threads (verified write-only — every writer set it
 * to NULL and nothing reads it) and a `'module-pr-factory-pr-threads'` row
 * in schema_version. The runner dedupes migrations by NAME, so this
 * migration uses a NEW name (`-v2`) to run on those DBs and recreate the
 * table without the column, preserving all rows.
 */
export const modulePrFactoryPrThreadsV2: Migration = {
  version: 101,
  name: 'module-pr-factory-pr-threads-v2',
  disableForeignKeys: true,
  up(db: Database.Database) {
    const TARGET = `
      CREATE TABLE pr_threads (
        channel_id      TEXT NOT NULL,
        thread_ts       TEXT NOT NULL,
        channel_type    TEXT NOT NULL,
        repo_full_name  TEXT NOT NULL,
        pr_number       INTEGER NOT NULL,
        session_id      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (channel_id, thread_ts)
      );

      CREATE INDEX idx_pr_threads_repo_pr ON pr_threads (repo_full_name, pr_number);
      CREATE INDEX idx_pr_threads_session ON pr_threads (session_id);
    `;

    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pr_threads'").get() as
      | { name: string }
      | undefined;

    if (!exists) {
      db.exec(TARGET);
      return;
    }

    const cols = db.prepare('PRAGMA table_info(pr_threads)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'bot_id')) return; // already v2 shape

    // Old fork shape — recreate without bot_id, carrying every row over.
    // The rename keeps the old table's indexes (and their names), so drop
    // them first or TARGET's CREATE INDEX collides.
    db.exec(`
      DROP INDEX IF EXISTS idx_pr_threads_repo_pr;
      DROP INDEX IF EXISTS idx_pr_threads_session;
      ALTER TABLE pr_threads RENAME TO pr_threads_old;
    `);
    db.exec(TARGET);
    db.exec(`
      INSERT INTO pr_threads (channel_id, thread_ts, channel_type, repo_full_name, pr_number, session_id, created_at)
      SELECT channel_id, thread_ts, channel_type, repo_full_name, pr_number, session_id, created_at
        FROM pr_threads_old
    `);
    db.exec('DROP TABLE pr_threads_old');
  },
};
