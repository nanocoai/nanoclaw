/**
 * One-off seed: the three paint products Kirk explicitly approved as
 * standard materials -- see the 2026-08-15 reconciliation against
 * Lowes_Email_Item_Catalog.xlsx.
 *
 * Deliberately hardcoded, not derived from any import: these three rows
 * are Kirk's own explicit decision, not something automatically promoted
 * from receipt history or Buy It Again. item_model_source is
 * 'receipt_history' because the Lowe's Item #/Model # values were
 * confirmed against real receipt rows; color_or_tint_source is
 * 'kirk_explicit' because "Latitude" and "High Hide White" do not appear
 * anywhere in the receipt data -- confirmed absent by direct search, not
 * merely unconfirmed. receipt_evidence_description preserves the raw
 * receipt wording found for each item, kept purely as evidence per Kirk's
 * explicit instruction not to treat it as authoritative for tint/base.
 *
 * Safe to re-run: upserts by (category), never creates duplicates.
 *
 * Ported from old commit 3ff49bd0. Adapted from the pre-async central DB
 * (raw better-sqlite3 `Database.Database` with `.prepare().get()/.run()`)
 * to the current async DbDriver (`await db.get/db.run(sql, ...params)`) --
 * no behavior change. `role: 'tool'` mirrors scripts/q.ts's convention for
 * standalone scripts connecting to the real central DB.
 */
import { randomUUID } from 'node:crypto';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import type { DbDriver } from '../src/db/driver.js';

interface Row {
  category: string;
  brand: string;
  product_line: string;
  sheen_or_type: string;
  color_or_tint: string | null;
  color_or_tint_source: 'kirk_explicit' | 'receipt_history' | 'buy_it_again';
  receipt_evidence_description: string | null;
  container_size: string;
  lowes_item_number: string;
  lowes_model_number: string;
  item_model_source: 'kirk_explicit' | 'receipt_history' | 'buy_it_again';
  confidence_note: string;
}

const ROWS: Row[] = [
  {
    category: 'ceiling_paint',
    brand: 'Valspar',
    product_line: 'Ultra',
    sheen_or_type: 'Ceiling Paint',
    color_or_tint: null,
    color_or_tint_source: 'kirk_explicit',
    receipt_evidence_description: '5G ULTRA CEILING PAINT',
    container_size: '5-gallon',
    lowes_item_number: '1967932',
    lowes_model_number: '007.1967932.008',
    item_model_source: 'receipt_history',
    confidence_note:
      'High confidence. "5G ULTRA CEILING PAINT" appears identically across all 4 receipt occurrences ' +
      '(3 under Item #1967932, 1 under Model #007.1967932.008, spanning 09/01/2025-05/04/2026). ' +
      'Structurally distinct from Item #670366 / Model #007.0670366.008 ("5G SIGNATURE FLAT CEILING"), ' +
      'confirming these are genuinely different products, not the same one under different naming. No tint/base variant applies to this product.',
  },
  {
    category: 'wall_paint',
    brand: 'Valspar',
    product_line: '4000',
    sheen_or_type: 'Eggshell',
    color_or_tint: 'Latitude',
    color_or_tint_source: 'kirk_explicit',
    receipt_evidence_description: '5G 4000 EGG WHT BASE / 5G 4000 EGG WHT BASE A',
    container_size: '5-gallon',
    lowes_item_number: '447517',
    lowes_model_number: '007.9447517.008',
    item_model_source: 'receipt_history',
    confidence_note:
      'High confidence on product/sheen/size: 7 occurrences under Item #447517 (01/06/2025-03/19/2026, $70.66-$79.03) ' +
      'plus 3 under Model #007.9447517.008 (05/04/2026-07/28/2026, $92.98-$99.98), consistently described "EGG WHT BASE [A]". ' +
      'Tint "Latitude" does NOT appear anywhere in the 673 parsed receipt line items or the 490-row item catalog -- ' +
      'confirmed absent by direct search, not merely unconfirmed. Latitude is Kirk-approved operational metadata only.',
  },
  {
    category: 'trim_paint',
    brand: 'Valspar',
    product_line: '4000',
    sheen_or_type: 'Semi-Gloss',
    color_or_tint: 'High Hide White',
    color_or_tint_source: 'kirk_explicit',
    receipt_evidence_description: '5G 4000 SEMI WHT BASE A',
    container_size: '5-gallon',
    lowes_item_number: '447521',
    lowes_model_number: '007.9447521.008',
    item_model_source: 'receipt_history',
    confidence_note:
      'High confidence on product/sheen/size: 2 occurrences under Item #447521 (09/12/2025, 10/29/2025, both $76.76) ' +
      'plus 1 under Model #007.9447521.008 (05/04/2026, $101.00), consistently described "SEMI WHT BASE A". ' +
      '"High Hide White" does NOT appear anywhere in the receipt data -- confirmed absent by direct search. ' +
      'The receipt phrase "WHT BASE A" does NOT prove this formulation is Valspar\'s "High Hide" base -- ' +
      'that mapping is Kirk-approved operational metadata only, not receipt-derived.',
  },
];

export interface SeedResult {
  created: number;
  updated: number;
}

/**
 * Pure upsert-by-category logic against an already-open DB connection --
 * takes `db` explicitly (rather than calling getDb() internally) so tests
 * can run it against an isolated test DB without ever touching the real
 * data/v2.db, same convention as sync-maintenance-property-info.ts's
 * syncOperationalInfo().
 */
export async function seedPreferredMaterialsPaints(db: DbDriver): Promise<SeedResult> {
  const now = new Date().toISOString();
  const approvedBy = 'Kirk Durham';

  let created = 0;
  let updated = 0;
  for (const r of ROWS) {
    const found = await db.get<{ id: string }>('SELECT id FROM preferred_materials WHERE category = ?', r.category);
    if (found) {
      await db.run(
        `UPDATE preferred_materials SET
           brand = ?, product_line = ?, sheen_or_type = ?, color_or_tint = ?, color_or_tint_source = ?,
           receipt_evidence_description = ?, container_size = ?, lowes_item_number = ?, lowes_model_number = ?,
           item_model_source = ?, status = 'approved', source = 'kirk_explicit', confidence_note = ?,
           approved_by = ?, approved_at = ?, updated_at = ?
         WHERE category = ?`,
        r.brand,
        r.product_line,
        r.sheen_or_type,
        r.color_or_tint,
        r.color_or_tint_source,
        r.receipt_evidence_description,
        r.container_size,
        r.lowes_item_number,
        r.lowes_model_number,
        r.item_model_source,
        r.confidence_note,
        approvedBy,
        now,
        now,
        r.category,
      );
      updated++;
    } else {
      await db.run(
        `INSERT INTO preferred_materials
           (id, category, brand, product_line, sheen_or_type, color_or_tint, color_or_tint_source,
            receipt_evidence_description, container_size, lowes_item_number, lowes_model_number, item_model_source,
            status, source, confidence_note, approved_by, approved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'kirk_explicit', ?, ?, ?, ?, ?)`,
        randomUUID(),
        r.category,
        r.brand,
        r.product_line,
        r.sheen_or_type,
        r.color_or_tint,
        r.color_or_tint_source,
        r.receipt_evidence_description,
        r.container_size,
        r.lowes_item_number,
        r.lowes_model_number,
        r.item_model_source,
        r.confidence_note,
        approvedBy,
        now,
        now,
        now,
      );
      created++;
    }
  }

  return { created, updated };
}

async function main(): Promise<void> {
  const db = await initDb(CENTRAL_DB_PATH, { role: 'tool' });
  const result = await seedPreferredMaterialsPaints(db);
  console.log(`Seeded preferred_materials: ${result.created} created, ${result.updated} updated.`);
  await closeDb();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
