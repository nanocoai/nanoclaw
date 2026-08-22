import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Key-binder model for Maintenance Coordinator. Keys aren't fixed at one
 * location -- they live in three portable binders Kirk moves around (he
 * may take one, two, or all three on a run). This is deliberately split
 * into three concerns, per Kirk's own distinction:
 *
 * `key_binders` -- static identity: which binders exist, and their
 * normal/home location (140 Richard Road) when nobody has them out.
 *
 * `key_binder_custody_events` -- append-only audit log of every custody
 * change, never updated or deleted (same discipline as
 * worker_time_events). This is what makes "who had binder 2 on the 14th"
 * answerable later.
 *
 * `key_binder_state` -- current-state snapshot, one row per binder,
 * mutable (same discipline as worker_state), for a fast "where is binder 2
 * right now" read. `holder_type` defaults to 'unknown' -- there is no
 * assumption that an untracked binder is at the office; Maintenance
 * Coordinator must never confidently send a worker to the office for a
 * key based only on the binder's *home* location. Unknown is a real,
 * intended state, not an error case.
 *
 * `property_operational_info.key_binder_id` (added below) is the STATIC
 * property→binder mapping ("this property's key normally lives in Binder
 * 1") -- a completely different fact from where Binder 1 actually *is*
 * right now, which only key_binder_state answers. Nullable and populated
 * gradually, never assumed complete. `access_source_note` covers the
 * non-binder case (lockbox code, tenant has key, etc).
 *
 * Also adds the remaining columns for Kirk's proposed
 * Maintenance-Coordinator-workbook layout (parking/entry notes, preferred
 * supply store, general notes) plus a JSON `extra` catch-all so a future
 * workbook column doesn't require another migration before the sync
 * script can capture it.
 *
 * Ported from old commit 824318ff. References workers(user_id)
 * (module-maintenance-transportation.ts, self-registered by
 * maintenance-worker-actions) and ALTERs property_operational_info
 * (module-maintenance-properties.ts, self-registered by
 * maintenance-properties, registered before this migration in
 * src/modules/maintenance-properties/index.ts's import order) -- MUST
 * register after both.
 */
export const moduleMaintenanceKeyBinders: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:key-binders',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE key_binders (
        id             TEXT PRIMARY KEY,
        label          TEXT NOT NULL,
        home_location  TEXT NOT NULL DEFAULT '140 Richard Road, Lexington, NC 27292',
        created_at     TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_key_binders_label ON key_binders(label);

      CREATE TABLE key_binder_custody_events (
        id                 TEXT PRIMARY KEY,
        binder_id          TEXT NOT NULL REFERENCES key_binders(id),
        holder_type        TEXT NOT NULL,
        holder_worker_id   TEXT REFERENCES workers(user_id),
        holder_note        TEXT NOT NULL DEFAULT '',
        changed_at         TEXT NOT NULL,
        recorded_at        TEXT NOT NULL,
        reported_by        TEXT,
        note               TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_key_binder_custody_events_binder ON key_binder_custody_events(binder_id, changed_at);

      CREATE TABLE key_binder_state (
        binder_id          TEXT PRIMARY KEY REFERENCES key_binders(id),
        holder_type        TEXT NOT NULL DEFAULT 'unknown',
        holder_worker_id   TEXT REFERENCES workers(user_id),
        holder_note        TEXT NOT NULL DEFAULT '',
        updated_at         TEXT NOT NULL
      );

      ALTER TABLE property_operational_info ADD COLUMN key_binder_id TEXT REFERENCES key_binders(id);
      ALTER TABLE property_operational_info ADD COLUMN access_source_note TEXT;
      ALTER TABLE property_operational_info ADD COLUMN parking_entry_notes TEXT;
      ALTER TABLE property_operational_info ADD COLUMN preferred_supply_store TEXT;
      ALTER TABLE property_operational_info ADD COLUMN general_notes TEXT;
      ALTER TABLE property_operational_info ADD COLUMN extra TEXT NOT NULL DEFAULT '{}';
    `);
  },
};
