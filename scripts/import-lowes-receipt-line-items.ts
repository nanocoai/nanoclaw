/**
 * One-off import: Lowes_Email_Item_Catalog.xlsx's "Line Items" sheet ->
 * lowes_purchase_line_items. This is the only source with genuine
 * per-purchase item-level detail (item#/model#, qty, price) -- the Pro CSV
 * is order-level only, Buy It Again is a recommendation snapshot, not a
 * purchase ledger.
 *
 * Run: pnpm exec tsx scripts/import-lowes-receipt-line-items.ts <path-to-xlsx>
 *
 * Ported from old commit 3ff49bd0. Adapted from the pre-async central DB
 * (raw better-sqlite3 `db.prepare(sql)` + sync `db.transaction(fn)`) to the
 * current async DbDriver (`await db.run(sql, ...params)` inside
 * `await db.transaction(async () => {...})`) -- sheet parsing/business
 * logic unchanged.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import XLSX from 'xlsx';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';

function parseMoney(s: string | null): number | null {
  if (!s) return null;
  const v = parseFloat(s.replace(/[$,]/g, ''));
  return Number.isNaN(v) ? null : v;
}

async function main(): Promise<void> {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error('Usage: import-lowes-receipt-line-items.ts <path-to-xlsx>');
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath, { type: 'file' });
  const ws = wb.Sheets['Line Items'];
  if (!ws) {
    console.error(`No "Line Items" sheet found in ${xlsxPath}. Sheets present: ${wb.SheetNames.join(', ')}`);
    process.exit(1);
  }

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false });
  const header = (grid[0] as string[]).map((h) => h.trim());

  const db = await initDb(CENTRAL_DB_PATH, { role: 'tool' });
  const now = new Date().toISOString();

  let imported = 0;
  let skipped = 0;

  await db.transaction(async () => {
    for (const raw of grid.slice(1)) {
      const row: Record<string, string> = {};
      header.forEach((h, i) => (row[h] = (raw[i] as string) ?? ''));

      if (!row['Purchase Date'] || !row['Description (receipt text)'] || !row['Identifier']) {
        skipped++;
        continue;
      }

      const identifierTypeRaw = row['Identifier Type'];
      const identifierType = /model/i.test(identifierTypeRaw) ? 'model_number' : 'item_number';

      await db.run(
        `INSERT INTO lowes_purchase_line_items
           (id, purchase_date, order_number, transaction_number, store_location, store_number, po_code_raw,
            description_raw, identifier_type, identifier_value, quantity, price_shown, source_format, gmail_message_id,
            source, imported_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'receipt_email', ?, ?)`,
        randomUUID(),
        row['Purchase Date'],
        row['Order #'] || null,
        row['Transaction #'] || null,
        row['Store'] || null,
        row['Store #'] || null,
        row['Customer/PO Code'] || null,
        row['Description (receipt text)'],
        identifierType,
        row['Identifier'],
        row['Quantity'] ? parseInt(row['Quantity'], 10) : null,
        parseMoney(row['Price Shown']),
        row['Source Format'] || null,
        row['Gmail Message ID'] || null,
        now,
        now,
      );
      imported++;
    }
  });

  console.log(
    `Imported ${imported} line items from ${path.basename(xlsxPath)} ("Line Items" sheet) (${skipped} incomplete rows skipped).`,
  );
  await closeDb();
}

await main();
