import type { Migration } from './index.js';

/**
 * Single-active-host leadership (one row per install).
 *
 * With the central DB on a network backend, two host processes on different
 * machines can point at the same database — and the only thing preventing a
 * second active host today is the node-local ncl-socket guard, which cannot
 * see across machines. This table is the coarse gate: exactly one instance
 * holds the leader row per `install_id`, CAS-acquired and lease-renewed like
 * the rest of the coordination tables (ISO-8601 strings, caller clocks). The
 * per-session claim fencing remains the fine-grained safety net underneath.
 *
 * On a SQLite central DB the election short-circuits host-side (same box by
 * construction) and this table stays empty.
 */
export const migration025: Migration = {
  version: 25,
  name: 'host-leadership',
  async up(db) {
    await db.exec(`
      CREATE TABLE host_leadership (
        install_id TEXT PRIMARY KEY,
        leader_instance_id TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL
      );
    `);
  },
};
