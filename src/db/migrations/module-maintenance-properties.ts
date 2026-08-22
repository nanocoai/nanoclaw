import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Maintenance Coordinator's property/location reference. Two-layer design
 * per the Phase 1 architecture plan:
 *
 * `properties` — derived, address-only. Populated by a host-side sync from
 * Lease Manager's own Read sheet (same read path lease-manager-generate
 * already uses) — never rent, deposit, tenant name, or lease status. No
 * agent container mounts the workbook to get this; Maintenance Coordinator
 * only ever sees this narrow, host-derived table.
 *
 * `property_operational_info` — Kirk-authored, separate from `properties`
 * on purpose: aliases/key-location/access-exceptions are maintenance
 * concerns, not lease data, and keeping them in their own table means
 * authoring them never touches Lease Manager's write-approval flow.
 *
 * `travel_times` — schema only for Phase 1; sparse, manually/incrementally
 * filled later. Not GPS/geofencing — a reasoning aid, not tracking.
 *
 * Ported from old commit 824318ff, self-registered via registerMigration()
 * from src/modules/maintenance-properties/index.ts. Must register before
 * module-maintenance-key-binders.ts, which ALTERs property_operational_info.
 */
export const moduleMaintenanceProperties: ModuleMigration = {
  version: 1,
  name: 'module:maintenance:properties',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE properties (
        id              TEXT PRIMARY KEY,
        canonical_name  TEXT NOT NULL,
        address         TEXT NOT NULL,
        unit            TEXT,
        source          TEXT NOT NULL DEFAULT 'lease-manager-sync',
        synced_at       TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_properties_address_unit ON properties(address, unit);

      CREATE TABLE property_operational_info (
        property_id           TEXT PRIMARY KEY REFERENCES properties(id),
        aliases                TEXT NOT NULL DEFAULT '[]',
        key_location            TEXT NOT NULL DEFAULT '140 Richard Road, Lexington, NC 27292',
        access_exceptions       TEXT NOT NULL DEFAULT '',
        updated_at              TEXT NOT NULL
      );

      CREATE TABLE travel_times (
        id           TEXT PRIMARY KEY,
        from_label   TEXT NOT NULL,
        to_label     TEXT NOT NULL,
        minutes      INTEGER NOT NULL,
        source       TEXT NOT NULL DEFAULT 'estimated',
        updated_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_travel_times_pair ON travel_times(from_label, to_label);
    `);
  },
};
