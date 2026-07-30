/**
 * SqliteStateAdapter namespace tests.
 *
 * All Chat SDK bridges share the chat_sdk_* tables in data/v2.db. Two
 * same-platform adapter instances see identical thread/message ids, so the
 * SDK's `dedupe:${adapter.name}:${message.id}` keys collide — the second
 * bot silently drops every message the first processed — unless each named
 * instance gets its own key namespace.
 *
 * The inverse constraint is just as load-bearing: the DEFAULT instance must
 * keep today's UNPREFIXED keys byte-identically, or live installs orphan
 * every existing subscription/lock/kv row on upgrade.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { SqliteStateAdapter } from './state-sqlite.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

async function makeAdapter(namespace?: string): Promise<SqliteStateAdapter> {
  const state = new SqliteStateAdapter(namespace);
  await state.connect();
  return state;
}

describe('default instance — legacy unprefixed keys (live-install regression arm)', () => {
  it('reads rows written before the namespace dimension existed', async () => {
    // A pre-existing install's subscription row: bare thread id.
    getDb().prepare("INSERT INTO chat_sdk_subscriptions (thread_id) VALUES ('T-raw')").run();
    const state = await makeAdapter();
    expect(await state.isSubscribed('T-raw')).toBe(true);
  });

  it('writes raw keys — kv, subscriptions, lists bind the exact input strings', async () => {
    const state = await makeAdapter();
    await state.set('k1', { v: 1 });
    await state.subscribe('slack:T1');
    await state.appendToList('l1', 'item');

    const kv = getDb().prepare('SELECT key FROM chat_sdk_kv').all() as Array<{ key: string }>;
    expect(kv.map((r) => r.key)).toEqual(['k1']);
    const subs = getDb().prepare('SELECT thread_id FROM chat_sdk_subscriptions').all() as Array<{
      thread_id: string;
    }>;
    expect(subs.map((r) => r.thread_id)).toEqual(['slack:T1']);
    const lists = getDb().prepare('SELECT key FROM chat_sdk_lists').all() as Array<{ key: string }>;
    expect(lists.map((r) => r.key)).toEqual(['l1']);
  });
});

describe('namespaced instance — round-trips and raw-key shape', () => {
  it('kv get/set/setIfNotExists/delete round-trip under a prefixed key', async () => {
    const state = await makeAdapter('slack-tester');
    await state.set('k1', { v: 42 });
    expect(await state.get('k1')).toEqual({ v: 42 });

    const raw = getDb().prepare('SELECT key FROM chat_sdk_kv').all() as Array<{ key: string }>;
    expect(raw.map((r) => r.key)).toEqual(['slack-tester:k1']);

    expect(await state.setIfNotExists('k1', 'other')).toBe(false);
    expect(await state.setIfNotExists('k2', 'fresh')).toBe(true);
    await state.delete('k1');
    expect(await state.get('k1')).toBeNull();
    expect(await state.get('k2')).toBe('fresh');
  });

  it('subscribe/isSubscribed/unsubscribe round-trip under a prefixed thread_id', async () => {
    const state = await makeAdapter('slack-tester');
    await state.subscribe('slack:T1');
    expect(await state.isSubscribed('slack:T1')).toBe(true);

    const raw = getDb().prepare('SELECT thread_id FROM chat_sdk_subscriptions').all() as Array<{
      thread_id: string;
    }>;
    expect(raw.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1']);

    await state.unsubscribe('slack:T1');
    expect(await state.isSubscribed('slack:T1')).toBe(false);
  });

  it('lists round-trip under a prefixed key', async () => {
    const state = await makeAdapter('slack-tester');
    await state.appendToList('history', 'a');
    await state.appendToList('history', 'b');
    expect(await state.getList('history')).toEqual(['a', 'b']);
    const raw = getDb().prepare('SELECT DISTINCT key FROM chat_sdk_lists').all() as Array<{ key: string }>;
    expect(raw.map((r) => r.key)).toEqual(['slack-tester:history']);
  });
});

describe('cross-namespace isolation', () => {
  it('setIfNotExists succeeds in BOTH namespaces (the SDK-dedupe collision fix)', async () => {
    const a = await makeAdapter('slack-worker');
    const b = await makeAdapter('slack-tester');
    // Same SDK dedupe key from both bots — each must win in its own space.
    expect(await a.setIfNotExists('dedupe:slack:m1', 1)).toBe(true);
    expect(await b.setIfNotExists('dedupe:slack:m1', 1)).toBe(true);
    // And re-asserting within one namespace still dedupes.
    expect(await a.setIfNotExists('dedupe:slack:m1', 1)).toBe(false);
  });

  it("one namespace's subscription is invisible to the other (and to the default)", async () => {
    const a = await makeAdapter('slack-worker');
    const b = await makeAdapter('slack-tester');
    const def = await makeAdapter();
    await a.subscribe('slack:T1');
    expect(await a.isSubscribed('slack:T1')).toBe(true);
    expect(await b.isSubscribed('slack:T1')).toBe(false);
    expect(await def.isSubscribed('slack:T1')).toBe(false);
  });
});

describe('locks under a namespace', () => {
  it('acquire returns the RAW threadId; extend and release hit the prefixed row', async () => {
    const state = await makeAdapter('slack-tester');
    const lock = await state.acquireLock('slack:T1', 5000);
    expect(lock).not.toBeNull();
    // Raw id on the Lock object — release/extend apply the prefix at their
    // own SQL sites. A prefixed id here would double-prefix on release.
    expect(lock!.threadId).toBe('slack:T1');

    const raw = getDb().prepare('SELECT thread_id FROM chat_sdk_locks').all() as Array<{ thread_id: string }>;
    expect(raw.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1']);

    expect(await state.extendLock(lock!, 10_000)).toBe(true);
    await state.releaseLock(lock!);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM chat_sdk_locks').get()).toEqual({ c: 0 });
  });

  it('same-thread locks in different namespaces do not contend', async () => {
    const a = await makeAdapter('slack-worker');
    const b = await makeAdapter('slack-tester');
    expect(await a.acquireLock('slack:T1', 5000)).not.toBeNull();
    expect(await b.acquireLock('slack:T1', 5000)).not.toBeNull();
    // Within one namespace the second acquire still fails.
    expect(await a.acquireLock('slack:T1', 5000)).toBeNull();
  });
});

describe('queue under a namespace', () => {
  it('enqueue → queueDepth → dequeue drains to empty; raw key is ns:queue:<tid>', async () => {
    const state = await makeAdapter('slack-tester');
    const entry = { message: { id: 'm1' } } as never;
    expect(await state.enqueue('slack:T1', entry, 10)).toBe(1);

    const raw = getDb().prepare('SELECT DISTINCT key FROM chat_sdk_lists').all() as Array<{ key: string }>;
    // Single prefix: enqueue must NOT apply k() itself (appendToList does);
    // a double prefix ('slack-tester:slack-tester:queue:…') never drains.
    expect(raw.map((r) => r.key)).toEqual(['slack-tester:queue:slack:T1']);

    expect(await state.queueDepth('slack:T1')).toBe(1);
    const out = await state.dequeue('slack:T1');
    expect(out).toEqual(entry);
    expect(await state.queueDepth('slack:T1')).toBe(0);
    expect(await state.dequeue('slack:T1')).toBeNull();
  });
});
