/**
 * One-off import: Lowe's Pro order-history CSV -> lowes_purchase_orders.
 * Read-only against the source CSV; only ever INSERTs new rows (re-running
 * against the same file is safe -- it just re-imports, callers should
 * clear the table first if they want a clean re-import rather than dupes).
 *
 * Run: pnpm exec tsx scripts/import-lowes-purchase-orders.ts <path-to-csv>
 *
 * Ported from old commit 3ff49bd0. Adapted from the pre-async central DB
 * (raw better-sqlite3 `db.prepare(sql)` + sync `db.transaction(fn)`) to the
 * current async DbDriver (`await db.run(sql, ...params)` inside
 * `await db.transaction(async () => {...})`) -- parsing/business logic
 * (CSV parsing, money parsing, date filtering, is_return derivation)
 * unchanged.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';

function parseMoney(s: string | undefined): number | null {
  if (!s || s === 'N/A') return null;
  let t = s.replace(/\$/g, '').replace(/,/g, '').trim();
  const neg = t.startsWith('-');
  t = t.replace(/-/g, '').trim();
  const v = parseFloat(t);
  if (Number.isNaN(v)) return null;
  return neg ? -v : v;
}

function parseCsvLine(line: string): string[] {
  // Minimal RFC4180-ish CSV parser sufficient for this export (quoted fields with commas, e.g. "Truck Delivery,Store Pick up").
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

const DATE_RE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;

async function main(): Promise<void> {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: import-lowes-purchase-orders.ts <path-to-csv>');
    process.exit(1);
  }

  let raw = fs.readFileSync(csvPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM if present
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);

  const db = await initDb(CENTRAL_DB_PATH, { role: 'tool' });
  const now = new Date().toISOString();

  let imported = 0;
  let skipped = 0;

  await db.transaction(async () => {
    for (const fields of lines.slice(1).map(parseCsvLine)) {
      const row: Record<string, string> = {};
      header.forEach((h, i) => (row[h] = fields[i] ?? ''));

      if (!DATE_RE.test(row['Date'])) {
        skipped++;
        continue; // footer/legend line, not data
      }

      const total = parseMoney(row['Order Total']);
      const isReturn =
        row['Fulfillment Type'] === 'Return' || row['Fulfillment Status'] === 'Returned' || (total !== null && total < 0)
          ? 1
          : 0;

      await db.run(
        `INSERT INTO lowes_purchase_orders
           (id, purchase_date, purchased_from, fulfillment_type, store_number, store_location, fulfillment_status,
            po_code_raw, order_number, invoice_number, tax, order_total, is_return, original_order_ref,
            purchaser_name, purchaser_email, raw_row_json, source, imported_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'lowes_pro_csv', ?, ?)`,
        randomUUID(),
        row['Date'],
        row['Purchased From'] || null,
        row['Fulfillment Type'] || null,
        row['Fulfillment Store #'] || null,
        row['Fulfillment Store Location'] || null,
        row['Fulfillment Status'] || null,
        row['PO Number'] || null,
        row['Order # / Trans. #'] || null,
        row['Invoice Number'] || null,
        parseMoney(row['Tax']),
        total,
        isReturn,
        row['Order Ref'] && row['Order Ref'] !== 'N/A' ? row['Order Ref'] : null,
        row['Purchaser Name'] && row['Purchaser Name'] !== 'N/A' ? row['Purchaser Name'] : null,
        row['Purchaser Email'] && row['Purchaser Email'] !== 'N/A' ? row['Purchaser Email'] : null,
        JSON.stringify(row),
        now,
        now,
      );
      imported++;
    }
  });

  console.log(`Imported ${imported} order rows from ${path.basename(csvPath)} (${skipped} non-data rows skipped).`);
  await closeDb();
}

await main();
