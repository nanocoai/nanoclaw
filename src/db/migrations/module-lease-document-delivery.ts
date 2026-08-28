import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Controlled document-delivery tables for Lease Manager-generated PDFs.
 *
 * `lease_generated_documents` — the artifact registry. One row per
 * successfully generated AND independently verified draft PDF, written only
 * by `lease-manager-generate/apply.ts` right after its own "does the file
 * actually exist" check passes. `id` is an opaque reference token — this is
 * the only thing an agent (Pepper) is ever given to identify a document; it
 * never carries or substitutes a filesystem path. Presence of a row here
 * *is* the verification signal — nothing else sets one.
 *
 * `lease_document_deliveries` — one row per delivery attempt (success or
 * failure), for the audit trail: which document, when, to what destination,
 * outcome. No tenant name/PII column on either table by design — the
 * property address is enough for a human to recognize which lease this was
 * without carrying tenant identity into a table two modules can read.
 *
 * Ported from old commit 59de60dc, self-registered via registerMigration().
 */
export const moduleLeaseDocumentDelivery: ModuleMigration = {
  version: 1,
  name: 'module:lease-manager:document-delivery',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE lease_generated_documents (
        id                     TEXT PRIMARY KEY,
        generation_request_id  TEXT NOT NULL,
        file_path               TEXT NOT NULL,
        property_address       TEXT NOT NULL,
        created_at             TEXT NOT NULL
      );

      CREATE TABLE lease_document_deliveries (
        id                        TEXT PRIMARY KEY,
        document_id               TEXT NOT NULL REFERENCES lease_generated_documents(id),
        attempted_at              TEXT NOT NULL,
        status                    TEXT NOT NULL,
        error                     TEXT,
        destination_channel_type  TEXT NOT NULL,
        destination_platform_id   TEXT NOT NULL,
        created_at                TEXT NOT NULL
      );

      CREATE INDEX idx_lease_document_deliveries_document
        ON lease_document_deliveries(document_id);
    `);
  },
};
