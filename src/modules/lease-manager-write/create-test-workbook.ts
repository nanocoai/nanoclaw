/**
 * One-time (re-runnable) generator for the synthetic Lease Manager test
 * workbook. Not part of the runtime pipeline -- run manually with
 * `pnpm exec tsx src/modules/lease-manager-write/create-test-workbook.ts`
 * whenever the baseline needs rebuilding (e.g. the production layout
 * changes and the test fixture needs to match).
 *
 * Entirely fictional data -- no real tenant information. Read-sheet cells
 * are plain values, not external-link formulas like production's (a
 * deliberate simplification; the Read-sheet-preservation verifier still
 * checks cell equality, just not formula equality, against this file).
 *
 * Writes directly to TEST_BASELINE_PATH_WSL via XLSX.writeFile -- safe here
 * because this is a brand-new synthetic file with no existing formulas/
 * formatting to risk, unlike the production workbook.
 *
 * Ported verbatim from old commit 59de60dc -- pure fs/XLSX I/O, no DB
 * access, nothing to adapt for the async DB migration. Not executed as
 * part of this reconciliation (manual, re-runnable script; no real or
 * synthetic workbook was generated while porting).
 */
import fs from 'node:fs';
import path from 'node:path';

import XLSX from 'xlsx';

import { TEST_BASELINE_PATH_WSL, TEST_WORKBOOK_PATH_WSL } from './config.js';

const readRows: (string | number | null)[][] = [
  [null, 'Deposit', null, null, 'Market Rent', 'Actual Rent', null, null, null, 'Address Reference'],
  ['Tenant Name', 'Deposit', 0, 'Address', 'Market Rate', 'Actual Rate ', 0, 0, null, null],
  [0, 0, 0, 0, 0, 0, 0, 0, null, null],
  [0, 0, 'Actual Revenue', 0, 'Market Rate', 'Rental Rate', 0, 0, null, null],
  [1, 3, 'Units ', 'Fictional Street', 0, 0, 0, 0, null, null],
  ['Fictional Tenant A', 500, 0, 'Fictional - A', 900, 850, 0, 0, null, '1 Fictional Street, Testville ST 00000'],
  [
    'Fictional Tenant B (roommate note)',
    600,
    0,
    'Fictional - B',
    950,
    900,
    0,
    0,
    null,
    '2 Fictional Street, Testville ST 00000',
  ],
  [0, 0, 0, 'Fictional - C', 800, 0, 0, 0, null, '3 Fictional Street, Testville ST 00000'],
  ['1A', 0, 0, 'Total', 2650, 1750, 0, 0, null, null],
  ['1B', 0, 0, 'Other', 800, 0, 0, 0, null, null],
];

const writeHeader = [
  'Name',
  'Address',
  'Rent',
  'Deposit ',
  'Market ',
  'Renewal Rent',
  'Lease Start Date',
  'Lease End Date',
  'Lease Reminder Date',
];

function build(): void {
  const wb = XLSX.utils.book_new();

  const readSheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(readSheet, readRows, { origin: 'C4' });
  XLSX.utils.book_append_sheet(wb, readSheet, 'Read');

  const writeSheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(writeSheet, [writeHeader], { origin: 'D5' });
  XLSX.utils.book_append_sheet(wb, writeSheet, 'Write');

  fs.mkdirSync(path.dirname(TEST_BASELINE_PATH_WSL), { recursive: true });
  XLSX.writeFile(wb, TEST_BASELINE_PATH_WSL);
  fs.copyFileSync(TEST_BASELINE_PATH_WSL, TEST_WORKBOOK_PATH_WSL);
  console.log(`Synthetic test workbook baseline written: ${TEST_BASELINE_PATH_WSL}`);
  console.log(`Active test workbook copy written: ${TEST_WORKBOOK_PATH_WSL}`);
}

build();
