/**
 * Chat SDK StateAdapter backed by SQLite.
 * Persists subscriptions, locks, KV, and lists across restarts.
 *
 * Ported from feat/chat-sdk-integration branch.
 */
import crypto from 'crypto';

import type Database from 'better-sqlite3';
import type { StateAdapter, QueueEntry } from 'chat';

import { getDb } from './db/connection.js';

interface Lock {
  threadId: string;
  token: string;
  expiresAt: number;
}

export class SqliteStateAdapter implements StateAdapter {
  private db!: Database.Database;

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
    this.cleanup();
  }

  async disconnect(): Promise<void> {}

  // --- Key-value ---

  async get<T = unknown>(key: string): Promise<T | null> {
    this.cleanup();
    const k = this.k(key);
    const row = this.db.prepare('SELECT value, expires_at FROM chat_sdk_kv WHERE key = ?').get(k) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at && row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM chat_sdk_kv WHERE key = ?').run(k);
      return null;
    }
    return JSON.parse(row.value) as T;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    this.db
      .prepare('INSERT OR REPLACE INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, ?)')
      .run(this.k(key), JSON.stringify(value), expiresAt);
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const k = this.k(key);
    const existing = this.db.prepare('SELECT expires_at FROM chat_sdk_kv WHERE key = ?').get(k) as
      | { expires_at: number | null }
      | undefined;
    if (existing?.expires_at && existing.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM chat_sdk_kv WHERE key = ?').run(k);
    }
    const expiresAt = ttlMs ? Date.now() + ttlMs : null;
    const result = this.db
      .prepare('INSERT OR IGNORE INTO chat_sdk_kv (key, value, expires_at) VALUES (?, ?, ?)')
      .run(k, JSON.stringify(value), expiresAt);
    return result.changes > 0;
  }

  async delete(key: string): Promise<void> {
    this.db.prepare('DELETE FROM chat_sdk_kv WHERE key = ?').run(this.k(key));
  }

  // --- Subscriptions ---

  async subscribe(threadId: string): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO chat_sdk_subscriptions (thread_id) VALUES (?)').run(this.k(threadId));
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM chat_sdk_subscriptions WHERE thread_id = ?').run(this.k(threadId));
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM chat_sdk_subscriptions WHERE thread_id = ? LIMIT 1')
      .get(this.k(threadId));
    return !!row;
  }

  // --- Locks ---

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const now = Date.now();
    const token = crypto.randomUUID();
    const expiresAt = now + ttlMs;
    const k = this.k(threadId);
    this.db.prepare('DELETE FROM chat_sdk_locks WHERE thread_id = ? AND expires_at < ?').run(k, now);
    const result = this.db
      .prepare('INSERT OR IGNORE INTO chat_sdk_locks (thread_id, token, expires_at) VALUES (?, ?, ?)')
      .run(k, token, expiresAt);
    if (result.changes === 0) return null;
    // The Lock carries the RAW threadId; release/extend re-apply k() at
    // their own SQL sites. Uniform — no un/re-prefixing on the caller side.
    return { threadId, token, expiresAt };
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.db
      .prepare('DELETE FROM chat_sdk_locks WHERE thread_id = ? AND token = ?')
      .run(this.k(lock.threadId), lock.token);
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const newExpiry = Date.now() + ttlMs;
    const result = this.db
      .prepare('UPDATE chat_sdk_locks SET expires_at = ? WHERE thread_id = ? AND token = ?')
      .run(newExpiry, this.k(lock.threadId), lock.token);
    if (result.changes > 0) {
      lock.expiresAt = newExpiry;
      return true;
    }
    return false;
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.db.prepare('DELETE FROM chat_sdk_locks WHERE thread_id = ?').run(this.k(threadId));
  }

  // --- Lists ---

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : null;
    const k = this.k(key);
    const maxRow = this.db.prepare('SELECT MAX(idx) as maxIdx FROM chat_sdk_lists WHERE key = ?').get(k) as
      | { maxIdx: number | null }
      | undefined;
    const nextIdx = (maxRow?.maxIdx ?? -1) + 1;
    this.db
      .prepare('INSERT INTO chat_sdk_lists (key, idx, value, expires_at) VALUES (?, ?, ?, ?)')
      .run(k, nextIdx, JSON.stringify(value), expiresAt);
    if (options?.maxLength) {
      const cutoff = nextIdx - options.maxLength;
      if (cutoff >= 0) {
        this.db.prepare('DELETE FROM chat_sdk_lists WHERE key = ? AND idx <= ?').run(k, cutoff);
      }
    }
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const now = Date.now();
    const rows = this.db
      .prepare(
        'SELECT value FROM chat_sdk_lists WHERE key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY idx ASC',
      )
      .all(this.k(key), now) as { value: string }[];
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
    const row = this.db
      .prepare('SELECT idx, value FROM chat_sdk_lists WHERE key = ? ORDER BY idx ASC LIMIT 1')
      .get(key) as { idx: number; value: string } | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM chat_sdk_lists WHERE key = ? AND idx = ?').run(key, row.idx);
    return JSON.parse(row.value) as QueueEntry;
  }

  async queueDepth(threadId: string): Promise<number> {
    const key = this.k(`queue:${threadId}`);
    const row = this.db.prepare('SELECT COUNT(*) as count FROM chat_sdk_lists WHERE key = ?').get(key) as {
      count: number;
    };
    return row.count;
  }

  // --- Cleanup ---

  private cleanup(): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM chat_sdk_kv WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
    this.db.prepare('DELETE FROM chat_sdk_locks WHERE expires_at < ?').run(now);
    this.db.prepare('DELETE FROM chat_sdk_lists WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  }
}
