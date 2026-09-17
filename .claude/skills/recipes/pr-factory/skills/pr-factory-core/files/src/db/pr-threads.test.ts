/**
 * pr-factory-core guard — pr_threads migration registration + DB layer.
 *
 * Runs the REAL migration barrel against a fresh DB and asserts the
 * pr_threads table exists with its composite primary key, both indexes, and
 * NO bot identity column (delivery identity lives on
 * messaging_groups.instance) — red if the modulePrFactoryPrThreadsV2 import
 * or array entry is deleted from src/db/migrations/index.ts. Exercises the
 * full CRUD surface of src/db/pr-threads.ts against the migrated schema, and
 * pins the fork-upgrade arm: a bot_id-shaped pr_threads (old recorded
 * migration name) is recreated without the column, rows preserved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import { migrations } from './migrations/index.js';
import {
  createPrThread,
  deletePrThread,
  getPrThread,
  getPrThreadByRepoPr,
  getPrThreadBySession,
  updatePrThreadSession,
  type PrThread,
} from './pr-threads.js';

function row(overrides: Partial<PrThread> = {}): PrThread {
  return {
    channel_id: 'slack:C0TEST',
    thread_ts: '1700000000.000100',
    channel_type: 'slack',
    repo_full_name: 'acme/widgets',
    pr_number: 42,
    session_id: 'sess-42',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('pr_threads migration', () => {
  it('creates the table with the (channel_id, thread_ts) composite primary key and no bot column', () => {
    const cols = getDb().prepare('PRAGMA table_info(pr_threads)').all() as Array<{ name: string; pk: number }>;
    expect(cols.length).toBeGreaterThan(0);
    const pk = cols
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['channel_id', 'thread_ts']);
    const names = cols.map((c) => c.name);
    for (const expected of ['channel_type', 'repo_full_name', 'pr_number', 'session_id', 'created_at']) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain('bot_id');
  });

  it('creates both lookup indexes', () => {
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pr_threads'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_pr_threads_repo_pr');
    expect(names).toContain('idx_pr_threads_session');
  });
});

describe('pr_threads fork upgrade (bot_id-shaped table)', () => {
  it('recreates an old bot_id-shaped pr_threads without the column, preserving rows', () => {
    closeDb();
    const db = initTestDb();
    // Run everything EXCEPT the v2 migration, then synthesize the old fork
    // state: bot_id-shaped table + the old recorded migration name.
    runMigrations(
      db,
      migrations.filter((m) => m.name !== 'module-pr-factory-pr-threads-v2'),
    );
    db.exec(`
      CREATE TABLE pr_threads (
        channel_id      TEXT NOT NULL,
        thread_ts       TEXT NOT NULL,
        channel_type    TEXT NOT NULL,
        bot_id          TEXT,
        repo_full_name  TEXT NOT NULL,
        pr_number       INTEGER NOT NULL,
        session_id      TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (channel_id, thread_ts)
      );
      CREATE INDEX idx_pr_threads_repo_pr ON pr_threads (repo_full_name, pr_number);
      CREATE INDEX idx_pr_threads_session ON pr_threads (session_id);
      INSERT INTO pr_threads VALUES
        ('slack:C0OLD', '1700000000.000200', 'slack', NULL, 'acme/widgets', 7, 'sess-old-7', '2025-01-01T00:00:00Z');
    `);
    db.prepare("INSERT INTO schema_version (version, name, applied) VALUES (?, 'module-pr-factory-pr-threads', ?)").run(
      900,
      new Date().toISOString(),
    );

    // The real barrel now applies ONLY the v2 migration (name-keyed dedupe
    // skips everything else, and the old name never blocks the new one).
    runMigrations(db);

    const names = (db.prepare('PRAGMA table_info(pr_threads)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(names).not.toContain('bot_id');
    expect(getPrThreadByRepoPr('acme/widgets', 7)?.session_id).toBe('sess-old-7');

    // Idempotent: a second pass changes nothing.
    runMigrations(db);
    expect(getPrThreadByRepoPr('acme/widgets', 7)?.session_id).toBe('sess-old-7');
  });
});

describe('pr-threads CRUD', () => {
  it('round-trips create → all three lookups', () => {
    createPrThread(row());

    expect(getPrThread('slack:C0TEST', '1700000000.000100')?.pr_number).toBe(42);
    expect(getPrThreadByRepoPr('acme/widgets', 42)?.session_id).toBe('sess-42');
    expect(getPrThreadBySession('sess-42')?.thread_ts).toBe('1700000000.000100');
    expect(getPrThreadByRepoPr('acme/widgets', 99)).toBeUndefined();
  });

  it('updatePrThreadSession repoints the row to a new session', () => {
    createPrThread(row());

    updatePrThreadSession('slack:C0TEST', '1700000000.000100', 'sess-fresh');
    expect(getPrThreadByRepoPr('acme/widgets', 42)?.session_id).toBe('sess-fresh');
    expect(getPrThreadBySession('sess-42')).toBeUndefined();
    expect(getPrThreadBySession('sess-fresh')?.pr_number).toBe(42);
  });

  it('deletePrThread removes the row', () => {
    createPrThread(row());
    deletePrThread('slack:C0TEST', '1700000000.000100');
    expect(getPrThread('slack:C0TEST', '1700000000.000100')).toBeUndefined();
    expect(getPrThreadByRepoPr('acme/widgets', 42)).toBeUndefined();
  });
});
