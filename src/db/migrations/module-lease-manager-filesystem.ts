import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Two tables supporting Lease Manager's scoped, host-enforced filesystem
 * capability -- see src/modules/lease-manager-filesystem/.
 *
 * `signed_lease_intake` -- one row per file Kirk uploads to Pepper for
 * Lease Manager to file. Staged host-side into Leases/Incoming (inside the
 * existing read-only-to-Lease-Manager mount, so no new mount is needed);
 * Pepper never touches the bytes. `status` tracks the lifecycle:
 * staged -> filed (moved into its final location via lease_fs_move) or
 * rejected (e.g. a naming collision that needs Kirk's decision).
 *
 * `lease_fs_operations` -- append-only audit log of every attempted
 * lease_fs_move / lease_fs_copy / lease_fs_mkdir, success or failure. This
 * is the "log every attempted file operation" requirement -- a row is
 * written at request time (status starts 'pending'), and updated through
 * approved/rejected/applied/failed as the operation actually proceeds.
 *
 * Ported from old commit 59de60dc, self-registered via registerMigration().
 */
export const moduleLeaseManagerFilesystem: ModuleMigration = {
  version: 1,
  name: 'module:lease-manager:filesystem',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE signed_lease_intake (
        id                        TEXT PRIMARY KEY,
        staged_path               TEXT NOT NULL,
        original_filename         TEXT NOT NULL,
        uploaded_by               TEXT NOT NULL,
        uploaded_via_message_id   TEXT NOT NULL,
        note                      TEXT,
        staged_at                 TEXT NOT NULL,
        status                    TEXT NOT NULL DEFAULT 'staged'
          CHECK (status IN ('staged', 'filed', 'rejected')),
        created_at                TEXT NOT NULL
      );

      CREATE TABLE lease_fs_operations (
        id                          TEXT PRIMARY KEY,
        operation_type              TEXT NOT NULL CHECK (operation_type IN ('move', 'copy', 'mkdir')),
        source_relative_path        TEXT,
        dest_relative_path          TEXT NOT NULL,
        context_note                TEXT,
        requested_by_agent_group_id TEXT NOT NULL,
        requested_by_session_id     TEXT,
        requested_at                TEXT NOT NULL,
        status                      TEXT NOT NULL
          CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
        approved_by                 TEXT,
        approved_at                 TEXT,
        applied_at                  TEXT,
        error                       TEXT,
        related_intake_id           TEXT REFERENCES signed_lease_intake(id),
        created_at                  TEXT NOT NULL
      );
      CREATE INDEX idx_lease_fs_operations_status ON lease_fs_operations(status);
    `);
  },
};
