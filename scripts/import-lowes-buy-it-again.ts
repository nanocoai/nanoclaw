/**
 * One-off import: "Buy it Again.xlsx" -> lowes_buy_it_again_candidates.
 * This is a scraped Lowe's.com "Buy It Again" page grid -- 5 parallel
 * columns, each stacking repeating 14-row product blocks (brand, title,
 * model#, Item#, a review-count-looking number, price, then UI-scrape
 * noise). Parsed by anchoring on the `Item#\d+` pattern, not fixed row
 * offsets, so it's robust to minor block-length variation.
 *
 * Run: pnpm exec tsx scripts/import-lowes-buy-it-again.ts <path-to-xlsx>
 *
 * Ported from old commit 3ff49bd0. Adapted from the pre-async central DB
 * (raw better-sqlite3 `db.prepare(sql)` + sync `db.transaction(fn)`) to the
 * current async DbDriver (`await db.run(sql, ...params)` inside
 * `await db.transaction(async () => {...})`) -- sheet parsing/business
 * logic unchanged, including the one-off (non-upserting) insert semantics:
 * lowes_item_number carries a UNIQUE index, so re-running against the same
 * export will fail on the second row it's already seen, same as before.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import XLSX from 'xlsx';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';

const COLUMNS = [
  [0, 'B'],
  [2, 'D'],
  [4, 'F'],
  [6, 'H'],
  [8, 'J'],
] as const;

interface Item {
  col: string;
  brand: string | null;
  title: string | null;
  model: string | null;
  itemNumber: string;
  mystery: string | null;
  price: string | null;
}

async function main(): Promise<void> {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error('Usage: import-lowes-buy-it-again.ts <path-to-xlsx>');
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath, { type: 'file' });
  const ws = wb.Sheets['Sheet1'];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false });

  const items: Item[] = [];
  for (const [col, colLabel] of COLUMNS) {
    for (let r = 0; r < grid.length; r++) {
      const cell = grid[r]?.[col];
      if (typeof cell === 'string' && /^Item#\d+$/.test(cell)) {
        const itemNumber = cell.replace('Item#', '');
        const model = typeof grid[r - 1]?.[col] === 'string' ? (grid[r - 1][col] as string) : null;
        const title = typeof grid[r - 2]?.[col] === 'string' ? (grid[r - 2][col] as string) : null;
        const brand = typeof grid[r - 3]?.[col] === 'string' ? (grid[r - 3][col] as string) : null;
        const mystery = typeof grid[r + 1]?.[col] === 'string' ? (grid[r + 1][col] as string) : null;
        const price =
          typeof grid[r + 2]?.[col] === 'string' && /^\$/.test(grid[r + 2][col] as string) ? (grid[r + 2][col] as string) : null;
        items.push({ col: colLabel, brand, title, model: model?.replace(/^Model#/, '') ?? null, itemNumber, mystery, price });
      }
    }
  }

  const db = await initDb(CENTRAL_DB_PATH, { role: 'tool' });
  const now = new Date().toISOString();

  let imported = 0;
  await db.transaction(async () => {
    for (const it of items) {
      const price = it.price ? parseFloat(it.price.replace(/[$,]/g, '')) : null;
      await db.run(
        `INSERT INTO lowes_buy_it_again_candidates
           (id, brand, title, model_number, lowes_item_number, price_observed, review_count_shown, snapshot_source_column,
            source, imported_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'buy_it_again_export', ?, ?)`,
        randomUUID(),
        it.brand,
        it.title ?? '(no title parsed)',
        it.model,
        it.itemNumber,
        price,
        it.mystery,
        it.col,
        now,
        now,
      );
      imported++;
    }
  });

  console.log(`Imported ${imported} Buy It Again candidates from ${path.basename(xlsxPath)}.`);
  await closeDb();
}

await main();
