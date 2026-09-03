/**
 * Chat SDK StateAdapter backed by SQLite.
 * Persists subscriptions, locks, KV, and lists across restarts.
 *
 * Ported from feat/chat-sdk-integration branch.
 */
import crypto from 'crypto';

import type { StateAdapter, QueueEntry } from 'chat';

import { getDb } from './db/connection.js';
import type { DbDriver } from './db/driver.js';
import { isUniqueViolation } from './db/errors.js';

interface Lock {
  threadId: string;
  token: string;
  expiresAt: number;
}

export class SqliteStateAdapter implements StateAdapter {
  private db!: DbDriver;

  /**
   * namespace = adapter-instance name; undefined ⇒ legacy unprefixed keys.
   *
   * All bridges share the same chat_sdk_* tables, and two same-platform
   * instances see identical thread/message ids — the SDK's dedupe key is
   * `dedupe:${adapter.name}:${message.id}`, so without a namespace the
   * second bot silently drops every message the first processed, locks
   * serialize across bots, and subscriptions leak engagement between them.
   *
   * The default instance MUST stay unprefixed: prefixing it would orphan
   * every live install's existing chat_sdk_subscriptions/kv/locks/lists
   * rows (silently killing engaged threads) with no clean way to rewrite
   * them. `k()` is the single choke point between every public method and
   * its SQL parameter — with namespace undefined it is the identity
   * function, so every statement binds the exact same strings as before.
   */
  constructor(private readonly namespace?: string) {}

  private k(key: string): string {
    return this.namespace ? `${this.namespace}:${key}` : key;
  }

  async connect(): Promise<void> {
    this.db = getDb();
    await this.cleanup();
  }

  async disconnect(): Promise<void> {}

  // --- Key-value ---

  async get<T = unknown>(key: string): Promise<T | null> {
    await this.cleanup();
    const k = this.k(key);
    const row = await this.db.get<{ value: string; expires_at: number | null }>(
      'SELECT value, expires_at FROM chat_sdk_kv WHERE key = ?',
      k,
    );
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) {
      await this.db.run('DELETE FROM chat_sdk_kv WHERE key = ?', k);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    await this.db.run(
      `INSERT INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      this.k(key),
      JSON.stringify(value),
      expiresAt,
    );
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const k = this.k(key);
    const existing = await this.db.get<{ expires_at: number | null }>(
      'SELECT expires_at FROM chat_sdk_kv WHERE key = ?',
      k,
    );
    if (existing?.expires_at && existing.expires_at < Date.now()) {
      await this.db.run('DELETE FROM chat_sdk_kv WHERE key = ?', k);
    }
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    const result = await this.db.run(
      'INSERT INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING',
      k,
      JSON.stringify(value),
      expiresAt,
    );
    return result.changes > 0;
  }

  async delete(key: string): Promise<void> {
    await this.db.run('DELETE FROM chat_sdk_kv WHERE key = ?', this.k(key));
  }

  // --- Subscriptions ---

  async subscribe(threadId: string): Promise<void> {
    await this.db.run(
      `INSERT INTO chat_sdk_subscriptions (thread_id, subscribed_at) VALUES (?, ?)
       ON CONFLICT (thread_id) DO UPDATE SET subscribed_at = excluded.subscribed_at`,
      this.k(threadId),
      new Date().toISOString(),
    );
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.db.run('DELETE FROM chat_sdk_subscriptions WHERE thread_id = ?', this.k(threadId));
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const row = await this.db.get('SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id = ? LIMIT 1', this.k(threadId));
    return !!row;
  }

  // --- Locks ---

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const now = Date.now();
    const token = crypto.randomUUID();
    const expiresAt = now + ttlMs;
    const k = this.k(threadId);
    await this.db.run('DELETE FROM chat_sdk_locks WHERE thread_id = ? AND expires_at < ?', k, now);
    const result = await this.db.run(
      `INSERT INTO chat_sdk_locks (thread_id, token, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (thread_id) DO NOTHING`,
      k,
      token,
      expiresAt,
    );
    if (result.changes === 0) return null;
    // The Lock carries the RAW threadId; release/extend re-apply k() at
    // their own SQL sites. Uniform — no un/re-prefixing on the caller side.
    return { threadId, token, expiresAt };
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.db.run(
      'DELETE FROM chat_sdk_locks WHERE thread_id = ? AND token = ?',
      this.k(lock.threadId),
      lock.token,
    );
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const newExpiry = Date.now() + ttlMs;
    const result = await this.db.run(
      'UPDATE chat_sdk_locks SET expires_at = ? WHERE thread_id = ? AND token = ?',
      newExpiry,
      this.k(lock.threadId),
      lock.token,
    );
    if (result.changes > 0) {
      lock.expiresAt = newExpiry;
      return true;
    }
    return false;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.db.run('DELETE FROM chat_sdk_locks WHERE thread_id = ?', this.k(threadId));
  }

  // --- Lists ---

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : null;
    const k = this.k(key);
    for (;;) {
      try {
        await this.db.transaction(async () => {
          const inserted = await this.db.get<{ idx: number }>(
            `INSERT INTO chat_sdk_lists (key, idx, value, expires_at)
             SELECT ?, COALESCE(MAX(idx), -1) + 1, ?, ?
               FROM chat_sdk_lists
              WHERE key = ?
             RETURNING idx`,
            k,
            JSON.stringify(value),
            expiresAt,
            k,
          );
          if (!inserted) throw new Error('Chat SDK list append returned no row');
          if (options?.maxLength) {
            const cutoff = inserted.idx - options.maxLength;
            if (cutoff >= 0) {
              await this.db.run('DELETE FROM chat_sdk_lists WHERE key = ? AND idx <= ?', k, cutoff);
            }
          }
        });
        return;
      } catch (error) {
        // Concurrent MVCC-backend appends can observe the same MAX(idx). The
        // primary key picks one winner; retry the loser after its savepoint /
        // transaction has rolled back so the next statement sees the winner.
        if (!isUniqueViolation(error)) throw error;
      }
    }
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const now = Date.now();
    const rows = await this.db.all<{ value: string }>(
      'SELECT value FROM chat_sdk_lists WHERE key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY idx ASC',
      this.k(key),
      now,
    );
    return rows.map((r) => JSON.parse(r.value) as T);
  }

  // --- Queue ---

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    // No k() here: appendToList prefixes at its own SQL boundary. Prefixing
    // twice would write `ns:ns:queue:<tid>` and the queue would never drain.
    // Resulting on-disk layout is `ns:queue:<tid>`.
    const key = `queue:${threadId}`;
    await this.appendToList(key, entry, { maxLength: maxSize });
    return await this.queueDepth(threadId);
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const key = this.k(`queue:${threadId}`);
    for (;;) {
      const row = await this.db.get<{ value: string }>(
        `DELETE FROM chat_sdk_lists
               WHERE key = ?
                 AND idx = (SELECT MIN(idx) FROM chat_sdk_lists WHERE key = ?)
           RETURNING value`,
        key,
        key,
      );
      if (row) return JSON.parse(row.value) as QueueEntry;

      // Concurrent statements on an MVCC backend can snapshot the same
      // MIN(idx). The loser returns no row after the winner commits; retry
      // only when a fresh statement can see another queued item.
      const remaining = await this.db.get<{ present: number }>(
        'SELECT 1 AS present FROM chat_sdk_lists WHERE key = ? LIMIT 1',
        key,
      );
      if (!remaining) return null;
    }
  }

  async queueDepth(threadId: string): Promise<number> {
    const key = this.k(`queue:${threadId}`);
    const row = await this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM chat_sdk_lists WHERE key = ?', key);
    if (!row) return 0;
    return row.count;
  }

  // --- Cleanup ---

  private async cleanup(): Promise<void> {
    const now = Date.now();
    await this.db.run('DELETE FROM chat_sdk_kv WHERE expires_at IS NOT NULL AND expires_at < ?', now);
    await this.db.run('DELETE FROM chat_sdk_locks WHERE expires_at < ?', now);
    await this.db.run('DELETE FROM chat_sdk_lists WHERE expires_at IS NOT NULL AND expires_at < ?', now);
  }
}
