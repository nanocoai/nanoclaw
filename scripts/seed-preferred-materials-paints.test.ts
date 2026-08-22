/**
 * Idempotency + provenance coverage for the preferred-materials paint seed.
 * Runs seedPreferredMaterialsPaints() directly against an isolated test DB
 * (initTestDb) -- never touches the real data/v2.db, and never spawns the
 * script's main() (guarded behind the import.meta.url check, so importing
 * this module for its exported function has no side effect).
 *
 * Ported from old commit 3ff49bd0. Adapted from the pre-async central DB
 * (`getDb().prepare(sql).get/run(...)`) to the current async DbDriver
 * (`await getDb().get/run(sql, ...)`) -- no behavior change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
// Side-effect import: registerMigration() must run before runMigrations()
// below sees the lowes-materials tables (see preferred-materials.test.ts
// for the same note).
import '../src/modules/lowes-materials/index.js';
import { seedPreferredMaterialsPaints } from './seed-preferred-materials-paints.js';

interface PreferredMaterialRow {
  category: string;
  brand: string;
  sheen_or_type: string;
  color_or_tint: string | null;
  color_or_tint_source: string;
  lowes_item_number: string;
  lowes_model_number: string;
  item_model_source: string;
  status: string;
  source: string;
  approved_by: string;
}

async function allRows(): Promise<PreferredMaterialRow[]> {
  return getDb().all<PreferredMaterialRow>(
    `SELECT category, brand, sheen_or_type, color_or_tint, color_or_tint_source,
            lowes_item_number, lowes_model_number, item_model_source, status, source, approved_by
     FROM preferred_materials ORDER BY category`,
  );
}

async function rowByCategory(category: string): Promise<PreferredMaterialRow> {
  const row = (await allRows()).find((r) => r.category === category);
  if (!row) throw new Error(`no row for category ${category}`);
  return row;
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('seedPreferredMaterialsPaints', () => {
  it('first run creates exactly the three Kirk-approved paint categories', async () => {
    const result = await seedPreferredMaterialsPaints(getDb());
    expect(result).toEqual({ created: 3, updated: 0 });

    const rows = await allRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.category)).toEqual(['ceiling_paint', 'trim_paint', 'wall_paint']);
  });

  it('second run creates no duplicates -- table still has exactly three rows', async () => {
    await seedPreferredMaterialsPaints(getDb());
    const second = await seedPreferredMaterialsPaints(getDb());

    expect(second).toEqual({ created: 0, updated: 3 });
    const rows = await allRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.category).sort()).toEqual(['ceiling_paint', 'trim_paint', 'wall_paint']);
  });

  it('re-running after a manual edit safely restores the intended row (update, not a second insert)', async () => {
    await seedPreferredMaterialsPaints(getDb());

    // Simulate a category drifting from what the seed intends -- e.g. a
    // stray manual edit -- and confirm re-running the seed corrects it
    // back, as one UPDATE, without creating a second row for the category.
    await getDb().run(
      `UPDATE preferred_materials SET color_or_tint = 'Wrong Tint', status = 'candidate' WHERE category = ?`,
      'wall_paint',
    );

    const result = await seedPreferredMaterialsPaints(getDb());
    expect(result).toEqual({ created: 0, updated: 3 });

    const rows = await allRows();
    expect(rows).toHaveLength(3);
    const wallPaint = await rowByCategory('wall_paint');
    expect(wallPaint.color_or_tint).toBe('Latitude');
    expect(wallPaint.status).toBe('approved');
  });

  it('never produces a fourth category or any row outside the three intended ones', async () => {
    await seedPreferredMaterialsPaints(getDb());
    await seedPreferredMaterialsPaints(getDb());
    await seedPreferredMaterialsPaints(getDb());

    const categories = (await allRows()).map((r) => r.category);
    expect(new Set(categories)).toEqual(new Set(['ceiling_paint', 'wall_paint', 'trim_paint']));
    expect(categories).toHaveLength(3);
  });

  it('provenance is correct on every row: source=kirk_explicit, item/model receipt-verified, tint Kirk-explicit', async () => {
    await seedPreferredMaterialsPaints(getDb());

    for (const row of await allRows()) {
      expect(row.status).toBe('approved');
      expect(row.source).toBe('kirk_explicit');
      expect(row.approved_by).toBe('Kirk Durham');
      // The item/model half is receipt-verified evidence.
      expect(row.item_model_source).toBe('receipt_history');
      expect(row.lowes_item_number).toBeTruthy();
      expect(row.lowes_model_number).toBeTruthy();
      // The color/tint half is Kirk's own knowledge, never receipt-derived --
      // confirmed absent from receipt data by direct search per the seed's
      // own doc comment, not merely unconfirmed.
      expect(row.color_or_tint_source).toBe('kirk_explicit');
    }

    // ceiling_paint has no tint/base variant; the other two carry Kirk's
    // explicit operational tint labels, never inferred from a receipt.
    expect((await rowByCategory('ceiling_paint')).color_or_tint).toBeNull();
    expect((await rowByCategory('wall_paint')).color_or_tint).toBe('Latitude');
    expect((await rowByCategory('trim_paint')).color_or_tint).toBe('High Hide White');
  });

  it("never reads from or writes into the raw Lowe's history tables -- no auto-promotion path exists", async () => {
    // Populate raw history with rows that could plausibly get confused with
    // the seed's own categories, then confirm seeding is entirely
    // unaffected by their presence/absence -- the seed's three rows are
    // hardcoded, never derived from a join or lookup against these tables.
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO lowes_purchase_line_items
         (id, purchase_date, description_raw, identifier_type, identifier_value, source, imported_at, created_at)
       VALUES ('li-1', '2026-01-01', '5G 4000 EGG WHT BASE A', 'item_number', '447517', 'receipt_email', ?, ?)`,
      now,
      now,
    );

    const result = await seedPreferredMaterialsPaints(getDb());
    expect(result).toEqual({ created: 3, updated: 0 });
    expect(await allRows()).toHaveLength(3);
  });
});
