import type Database from 'better-sqlite3';

import type { ModuleMigration } from './index.js';

/**
 * Lowe's materials tracking for Maintenance Coordinator -- three tables,
 * deliberately kept separate per Kirk's explicit instruction:
 *
 *   lowes_purchase_orders / lowes_purchase_line_items -- RAW purchase
 *     history, what was actually bought. Two tables because two different
 *     real sources exist at two different grains: the Lowe's Pro CSV
 *     export is order/transaction-level (no item detail at all); the
 *     130-receipt-email catalog is genuine per-line-item history. Neither
 *     is edited after import -- both are a durable, unedited mirror of
 *     their source.
 *
 *   lowes_buy_it_again_candidates -- Lowe's own "you've ordered this
 *     before" snapshot list. Kept structurally separate from purchase
 *     history even though the underlying semantics overlap: this is a
 *     recommendation Lowe's generated, not a ledger of transactions Kirk's
 *     business made.
 *
 *   preferred_materials -- the curated, Kirk-approved layer. Nothing here
 *     is ever auto-promoted from the other two tables; a row only reaches
 *     status='approved' by a human deciding so. Two explicit provenance
 *     columns (item_model_source, color_or_tint_source) because those two
 *     halves of a single row can have genuinely different evidence: the
 *     Lowe's item/model numbers are usually receipt-verified, but the
 *     operational tint/formulation label (e.g. "Latitude", "High Hide
 *     White") is very often Kirk's own knowledge that the receipt text
 *     can't confirm -- receipt_evidence_description preserves whatever raw
 *     wording *was* found (e.g. "5G 4000 EGG WHT BASE A") purely as
 *     evidence, explicitly never treated as the authoritative value for
 *     color/tint/formulation.
 *
 * Self-registered (not in the central migrations[] array) via
 * registerMigration() -- see src/modules/lowes-materials/index.ts. Ported
 * from old commit 3ff49bd0's module-lowes-materials.ts; behavior unchanged,
 * only the registration mechanism and the sqliteOnly/typing shape adapted to
 * the current PortableMigration | SqliteOnlyMigration split.
 */
export const moduleLowesMaterials: ModuleMigration = {
  version: 1,
  name: 'module:lowes-materials:core',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE lowes_purchase_orders (
        id                  TEXT PRIMARY KEY,
        purchase_date       TEXT NOT NULL,
        purchased_from      TEXT,
        fulfillment_type    TEXT,
        store_number        TEXT,
        store_location      TEXT,
        fulfillment_status  TEXT,
        po_code_raw         TEXT,
        order_number        TEXT,
        invoice_number      TEXT,
        tax                 REAL,
        order_total         REAL,
        is_return           INTEGER NOT NULL DEFAULT 0,
        original_order_ref  TEXT,
        purchaser_name      TEXT,
        purchaser_email     TEXT,
        raw_row_json        TEXT NOT NULL,
        source              TEXT NOT NULL DEFAULT 'lowes_pro_csv',
        imported_at         TEXT NOT NULL,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX idx_lowes_purchase_orders_date ON lowes_purchase_orders(purchase_date);

      CREATE TABLE lowes_purchase_line_items (
        id                 TEXT PRIMARY KEY,
        purchase_date      TEXT NOT NULL,
        order_number       TEXT,
        transaction_number TEXT,
        store_location     TEXT,
        store_number       TEXT,
        po_code_raw        TEXT,
        description_raw    TEXT NOT NULL,
        identifier_type    TEXT NOT NULL CHECK (identifier_type IN ('item_number', 'model_number')),
        identifier_value   TEXT NOT NULL,
        quantity           INTEGER,
        price_shown        REAL,
        source_format      TEXT,
        gmail_message_id   TEXT,
        source             TEXT NOT NULL DEFAULT 'receipt_email',
        imported_at        TEXT NOT NULL,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX idx_lowes_purchase_line_items_identifier ON lowes_purchase_line_items(identifier_value);
      CREATE INDEX idx_lowes_purchase_line_items_date ON lowes_purchase_line_items(purchase_date);

      CREATE TABLE lowes_buy_it_again_candidates (
        id                     TEXT PRIMARY KEY,
        brand                  TEXT,
        title                  TEXT NOT NULL,
        model_number           TEXT,
        lowes_item_number      TEXT NOT NULL,
        price_observed         REAL,
        review_count_shown     TEXT,
        snapshot_source_column TEXT,
        source                 TEXT NOT NULL DEFAULT 'buy_it_again_export',
        imported_at            TEXT NOT NULL,
        created_at             TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_lowes_buy_it_again_item_number ON lowes_buy_it_again_candidates(lowes_item_number);

      CREATE TABLE preferred_materials (
        id                            TEXT PRIMARY KEY,
        category                      TEXT NOT NULL,
        brand                         TEXT NOT NULL,
        product_line                  TEXT,
        sheen_or_type                  TEXT,
        color_or_tint                   TEXT,
        color_or_tint_source            TEXT NOT NULL DEFAULT 'kirk_explicit'
          CHECK (color_or_tint_source IN ('receipt_history', 'buy_it_again', 'kirk_explicit')),
        receipt_evidence_description     TEXT,
        container_size                    TEXT,
        lowes_item_number                  TEXT,
        lowes_model_number                  TEXT,
        item_model_source                    TEXT NOT NULL DEFAULT 'kirk_explicit'
          CHECK (item_model_source IN ('receipt_history', 'buy_it_again', 'kirk_explicit')),
        status                                 TEXT NOT NULL DEFAULT 'candidate'
          CHECK (status IN ('approved', 'candidate', 'deprecated')),
        source                                  TEXT NOT NULL
          CHECK (source IN ('receipt_history', 'buy_it_again', 'kirk_explicit')),
        confidence_note                          TEXT,
        approved_by                               TEXT,
        approved_at                                TEXT,
        created_at                                  TEXT NOT NULL,
        updated_at                                   TEXT NOT NULL
      );
    `);
  },
};
