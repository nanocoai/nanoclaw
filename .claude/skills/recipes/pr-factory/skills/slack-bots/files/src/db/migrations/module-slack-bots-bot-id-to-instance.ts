/**
 * Fork-upgrade migration (owned by the pr-factory `slack-bots` component
 * skill): convert a bot_id-shaped multi-bot DB to the native channel-instance
 * substrate. Pure no-op on fresh installs.
 *
 * Ordering is load-bearing: this runs immediately BEFORE migration 016
 * (messaging-group-instance) in the barrel. On a DB produced by the old
 * fork's `messaging-groups-bot-id` migration, 016's naked recreate would
 * silently drop `bot_id` and then its `instance = channel_type` backfill
 * would collide on UNIQUE(channel_type, platform_id, instance) for
 * supervisor/tester rows sharing the worker's platform_id — a boot
 * crash-loop. This migration recreates messaging_groups to 016's EXACT
 * target schema first, mapping bot_id → instance:
 *
 *   bot_id NULL            → instance = channel_type   (default instance)
 *   bot_id 'pr-supervisor' → instance = 'slack-supervisor'
 *   bot_id 'pr-tester'     → instance = 'slack-tester'
 *   any other bot_id       → instance = bot_id          (carried verbatim)
 *
 * 016's idempotency guard then sees the `instance` column and early-returns
 * (and the runner still records it as applied — the schema_version insert is
 * unconditional after up()).
 *
 * The same guarded arm rewrites the Chat SDK state namespace. The old fork's
 * bridge prefixed EVERY key with `botId ?? channelType` (worker keys were
 * 'slack:…'); the native substrate keeps the default instance UNPREFIXED and
 * prefixes named instances with the new instance names. So: strip the
 * LEADING 'slack:' prefix only (dedupe keys contain ':slack:' internally —
 * never blanket-replace), rename the 'pr-supervisor:'/'pr-tester:' prefixes
 * to the instance names, mirror all three on chat_sdk_subscriptions.thread_id,
 * and clear chat_sdk_locks (TTL-bound; at most one re-@mention per subscribed
 * thread after upgrade). Safe zero-touch: migrations run at boot before any
 * adapter starts, and this arm only fires on DBs that had `bot_id`, which
 * only the old fork bridge could have produced.
 *
 * disableForeignKeys: table recreate needs the DROP+RENAME window with FK
 * enforcement off (five child tables reference messaging_groups(id) — see
 * 016's header).
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const moduleSlackBotsBotIdToInstance: Migration = {
  version: 16, // ordering hint only — runner stores applied-order; sits right before 016
  name: 'module-slack-bots-bot-id-to-instance',
  disableForeignKeys: true,
  up: (db: Database.Database) => {
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'bot_id')) return; // fresh install / already converted

    // Old fork shape carried denied_at (migration 012 predates the fork's
    // bot_id migration), but tolerate a fork DB that lacks it.
    const deniedAt = cols.some((c) => c.name === 'denied_at') ? 'denied_at' : 'NULL';

    db.exec(`
      CREATE TABLE messaging_groups_new (
        id                    TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        platform_id           TEXT NOT NULL,
        instance              TEXT NOT NULL,
        name                  TEXT,
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
        created_at            TEXT NOT NULL,
        denied_at             TEXT,
        UNIQUE(channel_type, platform_id, instance)
      );
      INSERT INTO messaging_groups_new
        (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at, denied_at)
        SELECT id, channel_type, platform_id,
               CASE
                 WHEN bot_id IS NULL THEN channel_type
                 WHEN bot_id = 'pr-supervisor' THEN 'slack-supervisor'
                 WHEN bot_id = 'pr-tester' THEN 'slack-tester'
                 ELSE bot_id
               END,
               name, is_group, unknown_sender_policy, created_at, ${deniedAt}
          FROM messaging_groups;
      DROP TABLE messaging_groups;
      ALTER TABLE messaging_groups_new RENAME TO messaging_groups;
    `);

    // Chat SDK state rewrite — keyed tables first, then subscriptions, then
    // the TTL-bound locks. Leading-prefix matches only.
    for (const { table, col } of [
      { table: 'chat_sdk_kv', col: 'key' },
      { table: 'chat_sdk_lists', col: 'key' },
      { table: 'chat_sdk_subscriptions', col: 'thread_id' },
    ]) {
      db.exec(`
        UPDATE ${table} SET ${col} = substr(${col}, ${'slack:'.length + 1})
          WHERE ${col} LIKE 'slack:%';
        UPDATE ${table} SET ${col} = 'slack-supervisor:' || substr(${col}, ${'pr-supervisor:'.length + 1})
          WHERE ${col} LIKE 'pr-supervisor:%';
        UPDATE ${table} SET ${col} = 'slack-tester:' || substr(${col}, ${'pr-tester:'.length + 1})
          WHERE ${col} LIKE 'pr-tester:%';
      `);
    }
    db.exec('DELETE FROM chat_sdk_locks');
  },
};
