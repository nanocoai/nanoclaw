/**
 * pr-factory slack-bots guard — the fork-upgrade migration
 * (module-slack-bots-bot-id-to-instance) and its barrel placement.
 *
 * The migration's whole job is ordering-sensitive: it must convert a
 * bot_id-shaped fork DB to migration 016's exact target schema BEFORE 016
 * runs, or 016's recreate silently drops bot_id and its
 * `instance = channel_type` backfill collides on
 * UNIQUE(channel_type, platform_id, instance) for supervisor/tester rows
 * sharing the worker's platform_id — a boot crash-loop.
 *
 * Driven through the REAL runMigrations with the REAL barrel against a
 * synthetic fork-shaped DB (built by running the real pre-instance
 * migrations, then replaying the old fork's bot_id recreate + namespace-
 * prefixed Chat SDK state + stale fork schema_version names). Goes red if:
 *   - the migration is removed from the barrel, or moved AFTER 016
 *     (016 throws on the UNIQUE collision);
 *   - the bot_id → instance mapping drifts;
 *   - the Chat SDK key rewrite over-strips (internal ':slack:' dedupe
 *     segments), under-strips, or stops renaming the named prefixes;
 *   - the no-op guard breaks on fresh DBs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';
import { closeDb, initTestDb, runMigrations } from './index.js';
import { migrations } from './migrations/index.js';
import { moduleSlackBotsBotIdToInstance } from './migrations/module-slack-bots-bot-id-to-instance.js';

function tableCols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);
}

function appliedNames(db: Database.Database): string[] {
  return (db.prepare('SELECT name FROM schema_version ORDER BY version').all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

/**
 * Build a synthetic fork-shaped DB:
 *  1. real migrations up to (not including) the slack-bots shim — the
 *     pre-instance schema the fork forked from;
 *  2. the old fork's `messaging-groups-bot-id` recreate (bot_id column,
 *     UNIQUE(channel_type, platform_id, bot_id), partial NULL index);
 *  3. worker/supervisor/tester rows sharing one platform_id;
 *  4. namespace-prefixed chat_sdk_* state (the old fork bridge prefixed
 *     EVERY key with botId ?? channelType);
 *  5. stale fork migration names recorded in schema_version.
 */
function buildForkDb(db: Database.Database): void {
  const shimIdx = migrations.indexOf(moduleSlackBotsBotIdToInstance);
  expect(shimIdx).toBeGreaterThan(0); // barrel-presence leg: shim must be registered
  // Ordering leg: the shim must sit immediately before 016.
  expect(migrations[shimIdx + 1]?.name).toBe('messaging-group-instance');
  runMigrations(db, migrations.slice(0, shimIdx));

  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE messaging_groups_old (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      bot_id                TEXT,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at            TEXT NOT NULL,
      denied_at             TEXT,
      UNIQUE(channel_type, platform_id, bot_id)
    );
    INSERT INTO messaging_groups_old (id, channel_type, platform_id, bot_id, name, is_group, unknown_sender_policy, created_at, denied_at)
      SELECT id, channel_type, platform_id, NULL, name, is_group, unknown_sender_policy, created_at, denied_at
        FROM messaging_groups;
    DROP TABLE messaging_groups;
    ALTER TABLE messaging_groups_old RENAME TO messaging_groups;
    CREATE UNIQUE INDEX uq_messaging_groups_no_bot
      ON messaging_groups (channel_type, platform_id) WHERE bot_id IS NULL;
  `);
  db.pragma('foreign_keys = ON');

  const ins = db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, bot_id, name, is_group, unknown_sender_policy, created_at)
     VALUES (?, 'slack', 'C1', ?, NULL, 1, 'public', '2025-01-01T00:00:00Z')`,
  );
  ins.run('mg-worker', null);
  ins.run('mg-super', 'pr-supervisor');
  ins.run('mg-tester', 'pr-tester');

  const kv = db.prepare('INSERT INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, NULL)');
  kv.run('slack:dedupe:slack:M1', '"1"'); // worker key with an INTERNAL :slack: segment
  kv.run('pr-supervisor:dedupe:slack:M2', '"1"');
  kv.run('pr-tester:kv1', '"v"');
  db.prepare('INSERT INTO chat_sdk_lists (key, idx, value, expires_at) VALUES (?, 0, \'"x"\', NULL)').run(
    'pr-supervisor:list1',
  );
  const sub = db.prepare('INSERT INTO chat_sdk_subscriptions (thread_id) VALUES (?)');
  sub.run('slack:T-1');
  sub.run('pr-supervisor:T-2');
  sub.run('pr-tester:T-3');
  db.prepare('INSERT INTO chat_sdk_locks (thread_id, token, expires_at) VALUES (?, ?, ?)').run(
    'slack:T-1',
    'tok',
    Date.now() + 60_000,
  );

  // Stale fork migration names — recorded forever, harmlessly (the runner
  // dedupes by name; tip never reuses these).
  const ver = db.prepare(
    `INSERT INTO schema_version (version, name, applied)
     VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM schema_version), ?, ?)`,
  );
  ver.run('messaging-groups-bot-id', '2025-01-01T00:00:00Z');
  ver.run('module-pr-factory-pr-threads', '2025-01-01T00:00:00Z');
}

let db: Database.Database;

beforeEach(() => {
  db = initTestDb();
});

afterEach(() => {
  closeDb();
});

describe('module-slack-bots-bot-id-to-instance', () => {
  it('converts a fork-shaped DB: bot_id → instance, chat_sdk namespace rewrite, locks cleared', () => {
    buildForkDb(db);

    runMigrations(db); // full barrel — shim, then 016 (early-return), then the rest

    // messaging_groups is at 016's exact target schema.
    const cols = tableCols(db, 'messaging_groups');
    expect(cols).toContain('instance');
    expect(cols).not.toContain('bot_id');

    const byId = (id: string) =>
      db.prepare('SELECT instance FROM messaging_groups WHERE id = ?').get(id) as { instance: string };
    expect(byId('mg-worker').instance).toBe('slack');
    expect(byId('mg-super').instance).toBe('slack-supervisor');
    expect(byId('mg-tester').instance).toBe('slack-tester');

    // 016 must be RECORDED as applied even though its guard early-returned.
    const names = appliedNames(db);
    expect(names).toContain('module-slack-bots-bot-id-to-instance');
    expect(names).toContain('messaging-group-instance');

    // Chat SDK keyspace: worker unprefixed (internal ':slack:' untouched),
    // named prefixes renamed to the instance names.
    const kvKeys = (db.prepare('SELECT key FROM chat_sdk_kv ORDER BY key').all() as Array<{ key: string }>).map(
      (r) => r.key,
    );
    expect(kvKeys).toEqual(['dedupe:slack:M1', 'slack-supervisor:dedupe:slack:M2', 'slack-tester:kv1']);
    const listKeys = (db.prepare('SELECT key FROM chat_sdk_lists').all() as Array<{ key: string }>).map((r) => r.key);
    expect(listKeys).toEqual(['slack-supervisor:list1']);
    const subs = (
      db.prepare('SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id').all() as Array<{
        thread_id: string;
      }>
    ).map((r) => r.thread_id);
    expect(subs).toEqual(['T-1', 'slack-supervisor:T-2', 'slack-tester:T-3']);
    expect((db.prepare('SELECT count(*) AS n FROM chat_sdk_locks').get() as { n: number }).n).toBe(0);
  });

  it('is idempotent: a second runMigrations pass is a clean no-op', () => {
    buildForkDb(db);
    runMigrations(db);
    const before = {
      names: appliedNames(db),
      rows: db.prepare('SELECT id, instance FROM messaging_groups ORDER BY id').all(),
      kv: db.prepare('SELECT key FROM chat_sdk_kv ORDER BY key').all(),
    };
    expect(() => runMigrations(db)).not.toThrow();
    expect(appliedNames(db)).toEqual(before.names);
    expect(db.prepare('SELECT id, instance FROM messaging_groups ORDER BY id').all()).toEqual(before.rows);
    expect(db.prepare('SELECT key FROM chat_sdk_kv ORDER BY key').all()).toEqual(before.kv);
  });

  it('is a pure no-op on fresh DBs (016 does its normal recreate)', () => {
    runMigrations(db);
    const cols = tableCols(db, 'messaging_groups');
    expect(cols).toContain('instance');
    expect(cols).not.toContain('bot_id');
    expect(appliedNames(db)).toContain('module-slack-bots-bot-id-to-instance');
    // The default-instance backfill semantics are 016's own (guarded by
    // core's messaging-groups tests); here we only pin that the shim didn't
    // interfere with a fresh-path run.
  });
});
