/**
 * Guarded handler bodies for both lease_manager_write actions (production
 * and test) -- shared internals, parameterized by WriteTarget (./targets.ts),
 * with two thin exported entry points at the bottom.
 *
 * Runs only on an approved replay (see ./guard.ts — unconditional hold from
 * the container path). Sequence: sync the checked-in PowerShell script to
 * its fixed Windows-side location, write the approved plan to a temp file,
 * shell out to Excel COM (backup -> write -> reopen-verify, all inside the
 * .ps1), then independently re-read the workbook with a plain parser (never
 * XLSX.writeFile -- read-only here) to diff the target's Read sheet against
 * the pre-write backup and the Write sheet against the approved plan.
 * Reports back to Lease Manager's session either way; Lease Manager is
 * expected to relay the result to Kirk via the existing Pepper escalation
 * path, same as ambiguity questions.
 *
 * Lease Manager's container never touches the workbook or the mount for
 * this -- everything below runs host-side. The container can be RO-mounted
 * or unmounted entirely and this still works, for either target.
 *
 * Ported from old commit 59de60dc, adapted to await notifyAgent (now
 * async). Everything else here is child-process/fs/XLSX I/O with no
 * central-DB access at all -- nothing else to adapt for the async DB
 * migration.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import XLSX from 'xlsx';

import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';
import {
  APPLY_SCRIPT_DIR_WIN,
  APPLY_SCRIPT_DIR_WSL,
  APPLY_SCRIPT_PATH_WIN,
  LEASE_MANAGER_AGENT_GROUP_ID,
  POWERSHELL_EXE_WSL,
} from './config.js';
import type { RawLeaseRow } from './lease-fields.js';
import { PRODUCTION_TARGET, TEST_TARGET, type WriteTarget } from './targets.js';

const execFileAsync = promisify(execFile);

interface PlanRow extends RawLeaseRow {
  Name: string | null;
  Address: string;
  Rent: number | null;
  Deposit: number | null;
  Market: number | null;
  Status: string;
}

interface ApplyResult {
  ok: boolean;
  backupPath: string | null;
  written: number;
  appended: number;
  updated: number;
  skipped: number;
  skippedDetails: string[];
  reopenedOk: boolean;
  sheetNames: string[];
  error: string | null;
}

/** `C:\Users\Owner\...` -> `/mnt/c/Users/Owner/...` */
function winPathToWsl(p: string): string {
  return p.replace(/^([A-Za-z]):\\/, (_, drive) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

function readResultJson(stdout: string): ApplyResult {
  const line = stdout.split('\n').find((l) => l.startsWith('RESULT_JSON: '));
  if (!line) throw new Error(`apply-write-plan.ps1 produced no RESULT_JSON line. Raw output:\n${stdout}`);
  return JSON.parse(line.slice('RESULT_JSON: '.length));
}

async function applyWrite(target: WriteTarget, payload: Record<string, unknown>, session: Session): Promise<void> {
  // Re-check even though request.ts's precheck already gated this -- this
  // handler is the one that actually shells out to Windows, so it gets its
  // own independent check rather than trusting the earlier one transitively.
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    log.error(`${target.action} apply: rejected non-Lease-Manager session at apply time`, {
      agentGroupId: session.agent_group_id,
    });
    return;
  }

  const rows = payload.rows as PlanRow[];
  const requestId = (payload.requestId as string) || `lmw-${Date.now()}`;

  fs.mkdirSync(APPLY_SCRIPT_DIR_WSL, { recursive: true });

  // Sync the checked-in script to its fixed Windows-side location every run
  // -- guarantees the deployed script always matches the repo version, no
  // separate deploy step to forget. Resolved relative to this module's own
  // location: scripts/copy-build-assets.ts (run as part of `pnpm run
  // build`) copies apply-write-plan.ps1 alongside the compiled apply.js in
  // dist/, so this file always has that sibling at runtime. One script,
  // shared by both targets -- it's parameterized by -WorkbookPath/-BackupDir.
  const scriptSrc = path.join(path.dirname(new URL(import.meta.url).pathname), 'apply-write-plan.ps1');
  fs.copyFileSync(scriptSrc, path.join(APPLY_SCRIPT_DIR_WSL, 'apply-write-plan.ps1'));

  const planFileName = `plan-${requestId}.json`;
  const planPathWsl = path.join(APPLY_SCRIPT_DIR_WSL, planFileName);
  fs.writeFileSync(planPathWsl, JSON.stringify(rows, null, 2));
  const planPathWin = `${APPLY_SCRIPT_DIR_WIN}\\${planFileName}`;

  log.info(`${target.action}: invoking Excel COM apply`, { requestId, rowCount: rows.length, target: target.name });

  let result: ApplyResult;
  try {
    const { stdout } = await execFileAsync(POWERSHELL_EXE_WSL, [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      APPLY_SCRIPT_PATH_WIN,
      '-WorkbookPath',
      target.workbookPathWin,
      '-PlanPath',
      planPathWin,
      '-BackupDir',
      target.backupDirWin,
    ]);
    result = readResultJson(stdout);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error(`${target.action}: PowerShell invocation failed`, { requestId, err: msg });
    await notifyAgent(
      session,
      `Write plan approved but the apply step failed to run: ${msg}. Nothing should have changed -- a backup is made before any write is attempted, and this failure occurred before or during that step.`,
    );
    return;
  }

  if (!result.ok) {
    await notifyAgent(
      session,
      `Write plan approved but the apply step failed: ${result.error}. ` +
        (result.backupPath
          ? `A backup was made first: ${result.backupPath}.`
          : 'No backup was created (failure was before the backup step).'),
    );
    return;
  }

  if (!result.reopenedOk) {
    await notifyAgent(
      session,
      `Write completed (${result.written} rows) but the post-write reopen check FAILED -- the workbook may be damaged. ` +
        `Backup available at ${result.backupPath}. This needs your attention before anything else touches this file.`,
    );
    return;
  }

  // Independent verification: re-read (never write) the target workbook and
  // the backup with a plain parser, diff Read-sheet cell-for-cell against
  // the backup, and diff Write-sheet rows against the approved plan.
  let verifyReport: string;
  try {
    verifyReport = await verifyWrite(target, rows, result.backupPath);
  } catch (e) {
    verifyReport = `(independent verification could not run: ${e instanceof Error ? e.message : String(e)})`;
  }

  const skippedNote = result.skipped > 0 ? `\nSkipped ${result.skipped}: ${result.skippedDetails.join('; ')}` : '';
  const report =
    `${target.name === 'test' ? 'TEST (synthetic workbook) ' : ''}Lease workbook write completed.\n` +
    `Applied ${result.written} rows (${result.appended} new, ${result.updated} updated).${skippedNote}\n` +
    `Backup: ${result.backupPath}\n` +
    `Workbook reopened successfully after write.\n` +
    `${verifyReport}\n\n` +
    (target.name === 'test' ? '' : 'Please relay this to Kirk via Pepper.');

  await notifyAgent(session, report);
  log.info(`${target.action}: applied`, { requestId, written: result.written, skipped: result.skipped });
}

async function verifyWrite(
  target: WriteTarget,
  approvedRows: PlanRow[],
  backupPathWin: string | null,
): Promise<string> {
  const live = XLSX.readFile(target.workbookPathWsl, { type: 'file', cellFormula: true });

  const issues: string[] = [];

  if (backupPathWin) {
    const backupWsl = winPathToWsl(backupPathWin);
    const before = XLSX.readFile(backupWsl, { type: 'file', cellFormula: true });
    const readBefore = before.Sheets['Read'];
    const readAfter = live.Sheets['Read'];
    const beforeRange = XLSX.utils.decode_range(readBefore['!ref'] || 'A1');
    for (let r = beforeRange.s.r; r <= beforeRange.e.r; r++) {
      for (let c = beforeRange.s.c; c <= beforeRange.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const a = readBefore[addr];
        const b = readAfter[addr];
        const av = a ? JSON.stringify({ v: a.v, f: a.f }) : undefined;
        const bv = b ? JSON.stringify({ v: b.v, f: b.f }) : undefined;
        if (av !== bv) issues.push(`Read sheet changed at ${addr} (was ${av}, now ${bv})`);
      }
    }
  } else {
    issues.push('No backup path available -- could not verify Read sheet was untouched.');
  }

  const writeSheet = live.Sheets['Write'];
  // Dates read back as formatted strings (dateNF) so they compare directly
  // against the plan's "YYYY-MM-DD" values -- raw:true would give Excel
  // serial numbers for date cells instead.
  const grid = XLSX.utils.sheet_to_json<unknown[]>(writeSheet, {
    header: 1,
    defval: null,
    raw: false,
    dateNF: 'yyyy-mm-dd',
  });
  const byAddress = new Map<string, unknown[]>();
  for (const row of grid.slice(1)) {
    if (row[1]) byAddress.set(row[1] as string, row); // D=index0 Name, E=index1 Address
  }

  const hasKey = (row: PlanRow, key: keyof RawLeaseRow) => Object.prototype.hasOwnProperty.call(row, key);
  // raw:false (needed so date cells format via dateNF) turns numeric cells
  // into strings too, so numbers need explicit reparsing here -- careful not
  // to use `Number(v) || null`, which would wrongly turn a real 0 into null.
  const toNum = (v: unknown): number | null => (v === null || v === '' ? null : Number(v));

  let matched = 0;
  for (const planRow of approvedRows) {
    const found = byAddress.get(planRow.Address);
    if (!found) {
      issues.push(`Approved row not found in Write sheet: ${planRow.Address}`);
      continue;
    }
    const [name, , rent, deposit, market, , leaseStart, leaseEnd, leaseReminder, leaseStatus] = found;
    const mismatches: string[] = [];
    if ((name ?? null) !== planRow.Name) mismatches.push(`name: expected "${planRow.Name}", found "${name}"`);
    if (toNum(rent) !== planRow.Rent) mismatches.push(`rent: expected ${planRow.Rent}, found ${rent}`);
    if (toNum(deposit) !== planRow.Deposit) mismatches.push(`deposit: expected ${planRow.Deposit}, found ${deposit}`);
    if (toNum(market) !== planRow.Market) mismatches.push(`market: expected ${planRow.Market}, found ${market}`);
    // Lease fields: only verify what the resolved plan actually touched --
    // an absent key means "left untouched," nothing specific to compare.
    if (hasKey(planRow, 'LeaseStartDate') && ((leaseStart as string) || null) !== (planRow.LeaseStartDate ?? null)) {
      mismatches.push(`leaseStartDate: expected ${planRow.LeaseStartDate}, found ${leaseStart}`);
    }
    if (hasKey(planRow, 'LeaseEndDate') && ((leaseEnd as string) || null) !== (planRow.LeaseEndDate ?? null)) {
      mismatches.push(`leaseEndDate: expected ${planRow.LeaseEndDate}, found ${leaseEnd}`);
    }
    if (
      hasKey(planRow, 'LeaseReminderDate') &&
      ((leaseReminder as string) || null) !== (planRow.LeaseReminderDate ?? null)
    ) {
      mismatches.push(`leaseReminderDate: expected ${planRow.LeaseReminderDate}, found ${leaseReminder}`);
    }
    if (hasKey(planRow, 'LeaseStatus') && ((leaseStatus as string) || null) !== (planRow.LeaseStatus ?? null)) {
      mismatches.push(`leaseStatus: expected ${planRow.LeaseStatus}, found ${leaseStatus}`);
    }
    if (mismatches.length > 0) {
      issues.push(`Mismatch at ${planRow.Address}: ${mismatches.join(', ')}`);
    } else {
      matched++;
    }
  }

  if (issues.length === 0) {
    return `Independent verification: Read sheet byte-for-byte unchanged (all cells checked). All ${matched} Write-sheet rows match the approved plan exactly.`;
  }
  return `Independent verification found ${issues.length} issue(s):\n${issues.slice(0, 20).join('\n')}${issues.length > 20 ? `\n...and ${issues.length - 20} more` : ''}`;
}

// ── Production ──────────────────────────────────────────────────────────
export function applyLeaseManagerWrite(payload: Record<string, unknown>, session: Session): Promise<void> {
  return applyWrite(PRODUCTION_TARGET, payload, session);
}

// ── Test ─────────────────────────────────────────────────────────────────
export function applyLeaseManagerWriteTest(payload: Record<string, unknown>, session: Session): Promise<void> {
  return applyWrite(TEST_TARGET, payload, session);
}
