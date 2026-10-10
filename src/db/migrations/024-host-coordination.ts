import type { Migration } from './index.js';

/**
 * Durable host-coordination state (schema only — no writers yet). Every
 * coordination fact the host holds in process memory today is lost on
 * restart: delivery retry counts reset (a poison message retries forever
 * across a crash loop), stop/respawn intent vanishes after "rebuild
 * applied", and a stale `finish()` can stomp a fresh container. These
 * tables give each fact a durable home; the in-memory maps stay
 * authoritative until a follow-up flips authority to the rows, so this is
 * shadow surface for now.
 *
 * - `host_instances` — one row per live host process (lease). Lease expiry is
 *   compared as ISO-8601 strings; renewal is the host's heartbeat.
 * - `session_claims` — per-session incarnation fencing + durable stop intent.
 *   `incarnation` increments per container start; a compare-and-set on it is
 *   the spawn-dedup / stale-`finish()` fence. `stop_intent` outlives a host
 *   restart (`respawn_after_stop` replaces the volatile on-wake promise).
 * - `delivery_attempts` — outbound retry counts + backoff schedule, keyed by
 *   mailbox message id. `delivered` stays mailbox-side; only attempt
 *   bookkeeping lives here.
 * - `wake_signals` — durable "session has reason to wake" rows, written where
 *   mail is written and consumed by the wake path. Text ids (uuid) — no
 *   AUTOINCREMENT, the schema stays portable.
 */
export const migration024: Migration = {
  version: 24,
  name: 'host-coordination',
  async up(db) {
    await db.exec(`
      CREATE TABLE host_instances (
        instance_id TEXT PRIMARY KEY,
        install_id TEXT NOT NULL,
        hostname TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        stopped_at TEXT
      );

      CREATE TABLE session_claims (
        session_id TEXT PRIMARY KEY,
        incarnation INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        claimed_at TEXT,
        container_ref TEXT,
        stop_intent TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE delivery_attempts (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_error TEXT
      );
      CREATE INDEX idx_delivery_attempts_session ON delivery_attempts(session_id);

      CREATE TABLE wake_signals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by TEXT
      );
      CREATE INDEX idx_wake_signals_session_pending ON wake_signals(session_id, consumed_at);
    `);
  },
};
