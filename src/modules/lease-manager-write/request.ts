/**
 * Validation + hold-request builder for both lease_manager_write actions
 * (production and test) -- shared internals, parameterized by WriteTarget
 * (./targets.ts), with four thin exported entry points at the bottom.
 *
 * The delivery registry wraps each action with its own guard (see
 * ./guard.ts — unconditional hold from the container path): validation here
 * runs as the wrapper's precheck, and the hold builder creates the approval
 * card when the guard holds. On approve, the continuation re-enters the
 * wrapped action and ./apply.ts runs.
 *
 * The agent-group check here is the real security boundary for this whole
 * module (see config.ts) -- neither MCP tool has any way to influence it,
 * and neither can influence which workbook a request targets either (that's
 * baked into which target object the caller passed in, at the module edge,
 * never derived from `content`).
 *
 * Lease-field three-state resolution (absent/null/value) and status-driven
 * defaults live in ./lease-fields.ts and run here -- the payload that goes
 * to requestApproval (and from there to apply.ts) is always the *resolved*
 * plan, never the agent's raw submission. That's the one place these rules
 * are applied; apply.ts and the .ps1 writer just mechanically place values.
 *
 * Ported from old commit 59de60dc, adapted to await getAgentGroup/
 * notifyAgent/requestApproval (now async). validateLeaseManagerWrite and
 * validateLeaseManagerWriteTest change boolean -> Promise<boolean>,
 * matching DeliveryGuardSpec.precheck's accepted shape. readExistingLeaseFields
 * is pure sync XLSX/fs read (no DB) and is unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';

import XLSX from 'xlsx';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { LEASE_MANAGER_AGENT_GROUP_ID, MAX_PLAN_ROWS } from './config.js';
import {
  buildLeaseChangeLines,
  isValidDateString,
  isValidLeaseStatus,
  LeaseFieldValidationError,
  resolveLeaseFields,
  type ExistingLeaseFields,
  type RawLeaseRow,
} from './lease-fields.js';
import { PRODUCTION_TARGET, TEST_TARGET, type WriteTarget } from './targets.js';

interface PlanRow extends RawLeaseRow {
  Name: string | null;
  Address: string;
  Rent: number | null;
  Deposit: number | null;
  Market: number | null;
  Status: string;
}

const VALID_STATUS = new Set(['New', 'Update', 'Vacant']);

/** Three-state field check: absent is fine (untouched); when present, must be null or a valid date. */
function isValidOptionalDate(row: Record<string, unknown>, key: string): boolean {
  if (!(key in row)) return true;
  const v = row[key];
  return v === null || isValidDateString(v);
}

function isValidRow(r: unknown): r is PlanRow {
  if (typeof r !== 'object' || r === null) return false;
  const row = r as Record<string, unknown>;
  if (typeof row.Address !== 'string' || !row.Address.trim()) return false;
  if (row.Name !== null && typeof row.Name !== 'string') return false;
  if (row.Rent !== null && typeof row.Rent !== 'number') return false;
  if (row.Deposit !== null && typeof row.Deposit !== 'number') return false;
  if (row.Market !== null && typeof row.Market !== 'number') return false;
  if (typeof row.Status !== 'string' || !VALID_STATUS.has(row.Status)) return false;
  if (!isValidOptionalDate(row, 'LeaseStartDate')) return false;
  if (!isValidOptionalDate(row, 'LeaseEndDate')) return false;
  if (!isValidOptionalDate(row, 'LeaseReminderDate')) return false;
  if ('LeaseStatus' in row && row.LeaseStatus !== null && !isValidLeaseStatus(row.LeaseStatus)) return false;
  // Fixed Term requires an explicit end date in the same row -- checked here
  // (shape-level) rather than via resolveLeaseFields, so a malformed request
  // never gets far enough to build a card or write an audit file.
  if ('LeaseStatus' in row && row.LeaseStatus === 'Fixed Term') {
    if (!('LeaseEndDate' in row) || row.LeaseEndDate === null) return false;
  }
  return true;
}

async function validateWrite(action: string, content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    // Deliberately vague to the caller -- this tool is not meant to be used
    // by any other agent, so no error detail is owed beyond "not allowed."
    await notifyAgent(session, `${action} failed: not permitted for this agent.`);
    log.warn(`${action}: rejected non-Lease-Manager caller`, { agentGroupId: session.agent_group_id });
    return false;
  }

  const rows = content.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    await notifyAgent(session, `${action} failed: rows must be a non-empty array.`);
    return false;
  }
  if (rows.length > MAX_PLAN_ROWS) {
    await notifyAgent(session, `${action} failed: max ${MAX_PLAN_ROWS} rows per plan.`);
    return false;
  }
  const badIndex = rows.findIndex((r) => !isValidRow(r));
  if (badIndex !== -1) {
    await notifyAgent(
      session,
      `${action} failed: row ${badIndex} is malformed -- check Address/Status types, date formats ` +
        `(YYYY-MM-DD), LeaseStatus enum, and that Fixed Term rows include an explicit Lease End Date.`,
    );
    return false;
  }
  return true;
}

function summarizeByStatus(rows: PlanRow[]): string {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.Status] = (counts[r.Status] || 0) + 1;
  return Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
}

/** Read-only: current Write-sheet lease-field values, by address, from the target workbook. Never opens for write. */
function readExistingLeaseFields(target: WriteTarget): Map<string, ExistingLeaseFields> {
  const map = new Map<string, ExistingLeaseFields>();
  let wb;
  try {
    wb = XLSX.readFile(target.workbookPathWsl, { type: 'file', cellDates: true });
  } catch (e) {
    log.warn(`${target.action}: could not read target workbook for existing-value diff (treating all as new)`, {
      err: e instanceof Error ? e.message : String(e),
    });
    return map;
  }
  const ws = wb.Sheets['Write'];
  if (!ws) return map;
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false, dateNF: 'yyyy-mm-dd' });
  for (const row of grid.slice(1)) {
    const address = row[1] as string | null;
    if (!address) continue;
    map.set(address, {
      LeaseStartDate: (row[6] as string) || null, // J
      LeaseEndDate: (row[7] as string) || null, // K
      LeaseReminderDate: (row[8] as string) || null, // L
      LeaseStatus: (row[9] as string) || null, // M
    });
  }
  return map;
}

async function requestWriteHold(
  target: WriteTarget,
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return; // precheck already answered the requester

  const rawRows = content.rows as PlanRow[];
  const summary = (content.summary as string) || '';
  const requestId = `lmw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const existingByAddress = readExistingLeaseFields(target);

  // Resolve every row's lease fields (3-state + status defaults) once here.
  // This resolved array -- not the raw submission -- is what gets audited,
  // carded, and eventually written.
  let rows: PlanRow[];
  try {
    rows = rawRows.map((r) => ({ ...r, ...resolveLeaseFields(r) }));
  } catch (e) {
    if (e instanceof LeaseFieldValidationError) {
      await notifyAgent(session, `${target.action} failed: ${e.message}`);
      return;
    }
    throw e;
  }

  // Full plan persisted to a local, human-inspectable audit file -- test and
  // production land in separate directories, never mixed.
  const auditDir = path.join(GROUPS_DIR, agentGroup.folder, target.auditSubdir);
  fs.mkdirSync(auditDir, { recursive: true });
  const auditPath = path.join(auditDir, `${requestId}.json`);
  fs.writeFileSync(
    auditPath,
    JSON.stringify(
      { requestId, requestedAt: new Date().toISOString(), target: target.name, summary, rowCount: rows.length, rows },
      null,
      2,
    ),
  );

  const sample = rows
    .slice(0, 5)
    .map((r) => `  ${r.Status}: ${r.Name ?? '(vacant)'} — ${r.Address} (rent ${r.Rent ?? '—'})`)
    .join('\n');

  // Every lease-field change (set, update, or clear) rendered explicitly --
  // this is the "must be visible before writing" requirement. Only rows
  // that actually touch a lease field produce a block; rows with no
  // lease-field keys at all produce nothing here. Recompute the resolved
  // lease-fields-only object per row (cheap, pure) rather than reusing the
  // merged `rows` entries, which also carry Name/Address/Rent/etc. --
  // passing those to buildLeaseChangeLines would produce a line for every
  // field, lease or not.
  const leaseChangeBlocks: string[] = [];
  for (const raw of rawRows) {
    const existing = existingByAddress.get(raw.Address) ?? null;
    const lines = buildLeaseChangeLines(resolveLeaseFields(raw), existing);
    if (lines.length > 0) {
      leaseChangeBlocks.push(`  ${raw.Address}:\n${lines.map((l) => `    ${l}`).join('\n')}`);
    }
  }
  const leaseChangesSection =
    leaseChangeBlocks.length > 0
      ? `\n\nLease field changes (${leaseChangeBlocks.length} row(s)):\n${leaseChangeBlocks.slice(0, 10).join('\n')}${
          leaseChangeBlocks.length > 10 ? `\n  ...and ${leaseChangeBlocks.length - 10} more (see full plan)` : ''
        }`
      : '';

  // Target line is host-truth, not agent-supplied: read directly from the
  // target object the module edge chose (never derived from `content`), so
  // the card can't be made to look like a test when it isn't, or vice versa.
  const question =
    `${target.cardBanner}` +
    `TARGET WORKBOOK (host-configured, not agent-supplied): ${target.workbookPathWin}\n\n` +
    `Agent "${agentGroup.name}" wants to write to this workbook's Write sheet:\n` +
    `${rows.length} rows (${summarizeByStatus(rows)})${summary ? `\n${summary}` : ''}` +
    `${leaseChangesSection}\n\n` +
    `Sample:\n${sample}${rows.length > 5 ? `\n  ...and ${rows.length - 5} more` : ''}\n\n` +
    `Full plan saved for review: ${auditPath}`;

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: target.action,
    payload: { rows, summary, requestId, auditPath, target: target.name },
    title: target.name === 'test' ? 'Lease Workbook Write Request (TEST)' : 'Lease Workbook Write Request',
    question,
  });
}

// ── Production ──────────────────────────────────────────────────────────
export function validateLeaseManagerWrite(content: Record<string, unknown>, session: Session): Promise<boolean> {
  return validateWrite(PRODUCTION_TARGET.action, content, session);
}
export function requestLeaseManagerWriteHold(content: Record<string, unknown>, session: Session): Promise<void> {
  return requestWriteHold(PRODUCTION_TARGET, content, session);
}

// ── Test ─────────────────────────────────────────────────────────────────
export function validateLeaseManagerWriteTest(content: Record<string, unknown>, session: Session): Promise<boolean> {
  return validateWrite(TEST_TARGET.action, content, session);
}
export function requestLeaseManagerWriteTestHold(content: Record<string, unknown>, session: Session): Promise<void> {
  return requestWriteHold(TEST_TARGET, content, session);
}
