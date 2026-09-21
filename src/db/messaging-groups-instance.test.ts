/**
 * Channel-instance dimension tests (migration 016 + messaging-groups queries).
 *
 * Covers the three load-bearing rules:
 *   1. Backfill/default — instance = channel_type everywhere it isn't set,
 *      so single-instance installs behave byte-identically.
 *   2. UNIQUE(channel_type, platform_id, instance) — siblings coexist,
 *      single-bot pair-uniqueness is preserved via the default value.
 *   3. Lookup asymmetry — inbound (getMessagingGroupWithAgentCount) is
 *      exact-on-instance with NO fallback (unknown named instance ⇒ null ⇒
 *      router auto-creates instead of hijacking a sibling's row); outbound
 *      (getMessagingGroupByPlatform) is default-instance-first.
 *
 * The wired-DB arm reproduces the failure mode that bit migration 011: a
 * table recreate on a live DB with FK children. It must pass with
 * disableForeignKeys: true and fail without it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initSqliteTestDb, closeDb, getDb } from './connection.js';
import { sqliteRaw } from './drivers/sqlite.js';
import { runMigrations, migrations, type Migration } from './migrations/index.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  getMessagingGroupWithAgentCount,
} from './messaging-groups.js';
import type { MessagingGroup } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function mg(overrides: Partial<MessagingGroup> & { id: string }): MessagingGroup {
  return {
    channel_type: 'slack',
    platform_id: 'slack:C1',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
    ...overrides,
  };
}

afterEach(async () => {
  await closeDb();
});

describe('migration 016 — fresh DB', () => {
  beforeEach(async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
  });

  it('adds a NOT NULL instance column', () => {
    const cols = sqliteRaw(getDb()).prepare("PRAGMA table_info('messaging_groups')").all() as Array<{
      name: string;
      notnull: number;
    }>;
    const instance = cols.find((c) => c.name === 'instance');
    expect(instance).toBeDefined();
    expect(instance!.notnull).toBe(1);
  });

  it('createMessagingGroup without instance stamps instance = channel_type', async () => {
    await createMessagingGroup(mg({ id: 'mg-default' }));
    const row = sqliteRaw(getDb()).prepare("SELECT instance FROM messaging_groups WHERE id = 'mg-default'").get() as {
      instance: string;
    };
    expect(row.instance).toBe('slack');
  });

  it('allows sibling instances on the same (channel_type, platform_id)', async () => {
    await createMessagingGroup(mg({ id: 'mg-default' }));
    await createMessagingGroup(mg({ id: 'mg-tester', instance: 'slack-tester' }));
    const count = sqliteRaw(getDb()).prepare('SELECT COUNT(*) AS c FROM messaging_groups').get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('rejects a duplicate (channel_type, platform_id, instance) triple', async () => {
    await createMessagingGroup(mg({ id: 'mg-a', instance: 'slack-tester' }));
    await expect(createMessagingGroup(mg({ id: 'mg-b', instance: 'slack-tester' }))).rejects.toThrow();
  });

  it('rejects a duplicate default pair (single-bot uniqueness preserved)', async () => {
    await createMessagingGroup(mg({ id: 'mg-a' }));
    await expect(createMessagingGroup(mg({ id: 'mg-b' }))).rejects.toThrow();
  });
});

describe('migration 016 — wired legacy DB upgrade (the FK recreate arm)', () => {
  it('recreates messaging_groups under FK children without violations and backfills instance', async () => {
    const db = await initSqliteTestDb();
    // Bring the DB to the pre-016 schema.
    await runMigrations(
      db,
      migrations.filter((m) => m.name !== 'messaging-group-instance'),
    );
    const preCols = sqliteRaw(db).prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    expect(preCols.some((c) => c.name === 'instance')).toBe(false);

    // Seed a wired install: messaging_groups with live FK children
    // (messaging_group_agents + sessions reference messaging_groups.id).
    // Raw SQL — the new createMessagingGroup expects the instance column.
    sqliteRaw(db)
      .prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'A', 'a', ?)")
      .run(now());
    sqliteRaw(db)
      .prepare(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES ('mg-1', 'telegram', 'telegram:123', 'Chat', 0, 'public', ?)`,
      )
      .run(now());
    sqliteRaw(db)
      .prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, created_at)
       VALUES ('mga-1', 'mg-1', 'ag-1', 'pattern', 'all', 'drop', ?)`,
      )
      .run(now());
    sqliteRaw(db)
      .prepare(
        `INSERT INTO sessions (id, agent_group_id, messaging_group_id, created_at)
       VALUES ('sess-1', 'ag-1', 'mg-1', ?)`,
      )
      .run(now());

    // Upgrade: only 016 is pending now. Without disableForeignKeys this
    // throws 'FOREIGN KEY constraint failed' at DROP TABLE.
    await expect(runMigrations(db)).resolves.toBeUndefined();

    // Backfill: existing row got instance = channel_type.
    const row = sqliteRaw(db).prepare("SELECT instance FROM messaging_groups WHERE id = 'mg-1'").get() as {
      instance: string;
    };
    expect(row.instance).toBe('telegram');

    // Children intact and pointing at the recreated parent.
    expect(
      sqliteRaw(db).prepare("SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = 'mg-1'").get(),
    ).toEqual({ c: 1 });
    expect(sqliteRaw(db).prepare("SELECT COUNT(*) AS c FROM sessions WHERE messaging_group_id = 'mg-1'").get()).toEqual(
      { c: 1 },
    );

    // Full-DB FK integrity (FK enforcement was restored by the runner).
    expect(sqliteRaw(db).pragma('foreign_key_check')).toEqual([]);
    expect(sqliteRaw(db).pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('tolerates pre-existing FK orphans: the migration still applies (no boot crash-loop)', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(
      db,
      migrations.filter((m) => m.name !== 'messaging-group-instance'),
    );

    // Seed the orphan class that demonstrably exists on live installs
    // (ensureUserDm tolerates it at runtime): a user_dms row whose
    // messaging_group was deleted through a FK-OFF connection — the
    // sqlite3 CLI ships with foreign_keys OFF, and operators are told to
    // poke v2.db when troubleshooting.
    sqliteRaw(db).prepare("INSERT INTO users (id, kind, created_at) VALUES ('slack:U1', 'slack', ?)").run(now());
    sqliteRaw(db).pragma('foreign_keys = OFF');
    sqliteRaw(db)
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES ('slack:U1', 'slack', 'mg-deleted-via-cli', ?)`,
      )
      .run(now());
    sqliteRaw(db).pragma('foreign_keys = ON');
    expect(sqliteRaw(db).pragma('foreign_key_check')).toHaveLength(1);

    // 016 did not create this violation — it must still apply (the runner
    // diffs post-up violations against a pre-up snapshot and only throws
    // on NEW ones; pre-existing ones are warned about and carried through).
    await expect(runMigrations(db)).resolves.toBeUndefined();
    const cols = sqliteRaw(db).prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'instance')).toBe(true);

    // The orphan is untouched: still present, still the only violation.
    expect(sqliteRaw(db).pragma('foreign_key_check')).toHaveLength(1);
  });

  it('still rejects a migration that ITSELF introduces FK violations', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);

    const rogue: Migration = {
      version: 999,
      name: 'test-rogue-fk-violation',
      sqliteOnly: true,
      disableForeignKeys: true,
      up: (d) => {
        d.prepare("INSERT INTO users (id, kind, created_at) VALUES ('slack:U-rogue', 'slack', datetime('now'))").run();
        d.prepare(
          `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
           VALUES ('slack:U-rogue', 'slack', 'mg-never-existed', datetime('now'))`,
        ).run();
      },
    };

    await expect(runMigrations(db, [...migrations, rogue])).rejects.toThrow(/left FK violations/);

    // Rolled back atomically: not recorded as applied, nothing committed.
    expect(
      sqliteRaw(db).prepare("SELECT 1 FROM schema_version WHERE name = 'test-rogue-fk-violation'").get(),
    ).toBeUndefined();
    expect(sqliteRaw(db).pragma('foreign_key_check')).toEqual([]);
  });

  it('is idempotent — re-running the full barrel is a no-op', async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
    await createMessagingGroup(mg({ id: 'mg-keep', instance: 'slack-tester' }));
    await expect(runMigrations(db)).resolves.toBeUndefined();
    const row = sqliteRaw(db).prepare("SELECT instance FROM messaging_groups WHERE id = 'mg-keep'").get() as {
      instance: string;
    };
    expect(row.instance).toBe('slack-tester');
  });
});

describe('lookup asymmetry — inbound exact-only vs outbound default-first', () => {
  beforeEach(async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db);
    // The named instance ('alpha-tester') sorts lexically BEFORE the
    // channel type ('slack') and is inserted first — so both rowid order
    // and the triple-autoindex order put it ahead of the default row.
    // A query missing the `(instance = channel_type) DESC` ORDER BY would
    // return it; only the deterministic default-first ordering picks
    // mg-default.
    await createMessagingGroup(mg({ id: 'mg-tester', instance: 'alpha-tester' }));
    await createMessagingGroup(mg({ id: 'mg-default' }));
  });

  it('getMessagingGroupWithAgentCount without instance resolves the default-instance row', async () => {
    const found = await getMessagingGroupWithAgentCount('slack', 'slack:C1');
    expect(found).not.toBeNull();
    expect(found!.mg.id).toBe('mg-default');
  });

  it('getMessagingGroupWithAgentCount with a named instance resolves exactly that row', async () => {
    const found = await getMessagingGroupWithAgentCount('slack', 'slack:C1', 'alpha-tester');
    expect(found).not.toBeNull();
    expect(found!.mg.id).toBe('mg-tester');
  });

  it('getMessagingGroupWithAgentCount with an unknown instance returns null (no-hijack rule)', async () => {
    expect(await getMessagingGroupWithAgentCount('slack', 'slack:C1', 'slack-unknown')).toBeNull();
  });

  it('getMessagingGroupByPlatform without instance prefers the default-instance row', async () => {
    const found = await getMessagingGroupByPlatform('slack', 'slack:C1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('mg-default');
  });

  it('getMessagingGroupByPlatform with explicit instance is exact', async () => {
    expect((await getMessagingGroupByPlatform('slack', 'slack:C1', 'alpha-tester'))!.id).toBe('mg-tester');
    expect(await getMessagingGroupByPlatform('slack', 'slack:C1', 'slack-unknown')).toBeUndefined();
  });

  it('getMessagingGroupByPlatform falls back deterministically when only named instances exist', async () => {
    const db = getDb();
    sqliteRaw(db).prepare("DELETE FROM messaging_groups WHERE id = 'mg-default'").run();
    await createMessagingGroup(mg({ id: 'mg-zeta', instance: 'zeta' }));
    const found = await getMessagingGroupByPlatform('slack', 'slack:C1');
    // Lexically-first named instance: 'alpha-tester' < 'zeta'.
    expect(found!.id).toBe('mg-tester');
  });
});
