import type { Migration } from './index.js';

/**
 * Per-agent-group timezone override on `container_configs`.
 *
 * NULL = follow the install-global timezone (TZ in .env / system), matching
 * pre-migration behavior for every existing row — deliberately no backfill.
 * A non-NULL value is a validated IANA id (rejected at the ncl write path);
 * it grounds host-side scheduling (cron parsing, --process-after, run-log
 * stamps) immediately and the container's TZ env on next respawn.
 */
export const migration020: Migration = {
  version: 20,
  name: 'container-config-timezone',
  sqliteOnly: true,
  up(db) {
    db.exec(`ALTER TABLE container_configs ADD COLUMN timezone TEXT;`);
  },
};
