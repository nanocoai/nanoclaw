/**
 * Validation + hold-request builder for lease_manager_generate.
 *
 * The delivery registry wraps the action with its own guard (see ./guard.ts
 * — unconditional hold from the container path): validation here runs as
 * the wrapper's precheck, and the hold builder creates the approval card
 * when the guard holds. On approve, the continuation re-enters the wrapped
 * action and ./apply.ts runs the actual generation.
 *
 * The agent-group check here is the real security boundary for this module
 * (see config.ts) -- the MCP tool has no way to influence it, and no way to
 * influence where the PDF is written or what it's named either (that's
 * entirely internal to the Python generator; this module's payload carries
 * lease *data* only, never a path).
 *
 * This is the "assemble and show the proposed lease data for review" step
 * Kirk asked for, enforced by trusted host code rather than agent good
 * behavior: the card always shows the complete field set, cross-checked
 * against whatever the workbook has on file for that address (when found),
 * with any mismatch surfaced explicitly rather than silently preferring one
 * source over the other.
 *
 * Ported from old commit 59de60dc, adapted to await getAgentGroup/
 * notifyAgent/requestApproval (now async). validateLeaseManagerGenerate's
 * signature changes boolean -> Promise<boolean>, matching
 * DeliveryGuardSpec.precheck's accepted shape. readWorkbookRow itself is
 * pure sync fs/xlsx logic (no DB access) and is unchanged.
 */
import XLSX from 'xlsx';

import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent, requestApproval } from '../approvals/index.js';
import { DRAFTS_DIR_WIN, LEASE_MANAGER_AGENT_GROUP_ID, WORKBOOK_PATH_WSL } from './config.js';

export interface GenerationPlan {
  tenant_names: string[];
  property_address: string;
  rent: number;
  security_deposit: number;
  lease_start_date: string; // MM/DD/YYYY
  lease_end_date: string; // MM/DD/YYYY
  fixed_term_continuation_policy?: 'month_to_month' | 'must_vacate';
  agreement_date?: string;
  signature_dates?: { tenant1?: string; tenant2?: string; landlord?: string };
}

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

function isValidPlan(p: unknown): p is GenerationPlan {
  if (typeof p !== 'object' || p === null) return false;
  const row = p as Record<string, unknown>;
  if (!Array.isArray(row.tenant_names) || row.tenant_names.length < 1 || row.tenant_names.length > 2) return false;
  if (!row.tenant_names.every((n) => typeof n === 'string' && n.trim())) return false;
  if (typeof row.property_address !== 'string' || !row.property_address.trim()) return false;
  if (typeof row.rent !== 'number' || row.rent < 0) return false;
  if (typeof row.security_deposit !== 'number' || row.security_deposit < 0) return false;
  if (typeof row.lease_start_date !== 'string' || !DATE_RE.test(row.lease_start_date)) return false;
  if (typeof row.lease_end_date !== 'string' || !DATE_RE.test(row.lease_end_date)) return false;
  if (
    row.fixed_term_continuation_policy !== undefined &&
    row.fixed_term_continuation_policy !== 'month_to_month' &&
    row.fixed_term_continuation_policy !== 'must_vacate'
  )
    return false;
  if (row.agreement_date !== undefined && (typeof row.agreement_date !== 'string' || !DATE_RE.test(row.agreement_date)))
    return false;
  if (row.signature_dates !== undefined) {
    if (typeof row.signature_dates !== 'object' || row.signature_dates === null) return false;
    const sd = row.signature_dates as Record<string, unknown>;
    for (const k of Object.keys(sd)) {
      if (k !== 'tenant1' && k !== 'tenant2' && k !== 'landlord') return false;
      if (typeof sd[k] !== 'string' || !DATE_RE.test(sd[k] as string)) return false;
    }
  }
  return true;
}

interface WorkbookRow {
  Name: string | null;
  Rent: number | null;
  Deposit: number | null;
  LeaseStatus: string | null;
}

/** Read-only: current Write-sheet row for one address, by exact match. Never opens for write. */
function readWorkbookRow(address: string): WorkbookRow | null {
  let wb;
  try {
    wb = XLSX.readFile(WORKBOOK_PATH_WSL, { type: 'file', cellDates: true });
  } catch (e) {
    log.warn('lease_manager_generate: could not read workbook for cross-check (proceeding without it)', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
  const ws = wb.Sheets['Write'];
  if (!ws) return null;
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: false, dateNF: 'yyyy-mm-dd' });
  for (const row of grid.slice(1)) {
    if ((row[1] as string | null) === address) {
      return {
        Name: (row[0] as string) || null,
        Rent: row[2] === null ? null : Number(row[2]),
        Deposit: row[3] === null ? null : Number(row[3]),
        LeaseStatus: (row[9] as string) || null,
      };
    }
  }
  return null;
}

export async function validateLeaseManagerGenerate(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (session.agent_group_id !== LEASE_MANAGER_AGENT_GROUP_ID) {
    await notifyAgent(session, 'lease_manager_generate failed: not permitted for this agent.');
    log.warn('lease_manager_generate: rejected non-Lease-Manager caller', { agentGroupId: session.agent_group_id });
    return false;
  }

  const plan = content.plan;
  if (!isValidPlan(plan)) {
    await notifyAgent(
      session,
      'lease_manager_generate failed: plan is malformed -- check tenant_names (1-2 non-empty strings), ' +
        'property_address, rent/security_deposit (numbers), lease_start_date/lease_end_date (MM/DD/YYYY), ' +
        'and optional fixed_term_continuation_policy/agreement_date/signature_dates.',
    );
    return false;
  }

  // Fixed-Term only for v1: hard reject before any hold is created if the
  // workbook already has this address on record as Month-to-Month.
  const onFile = readWorkbookRow(plan.property_address);
  if (onFile?.LeaseStatus === 'Month-to-Month') {
    await notifyAgent(
      session,
      `lease_manager_generate failed: the workbook shows ${plan.property_address} as Month-to-Month. ` +
        'Fixed-Term lease generation is the only supported document type in v1 -- Month-to-Month PDF generation ' +
        'has not been designed or approved yet. If this is wrong, check with Kirk before proceeding.',
    );
    return false;
  }

  return true;
}

export async function requestLeaseManagerGenerateHold(
  content: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return; // precheck already answered the requester

  const plan = content.plan as GenerationPlan;
  const summary = (content.summary as string) || '';
  const requestId = `lmg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const onFile = readWorkbookRow(plan.property_address);

  const mismatches: string[] = [];
  if (onFile) {
    if (onFile.Rent !== null && onFile.Rent !== plan.rent) {
      mismatches.push(`Rent: submitted $${plan.rent.toFixed(2)}, workbook has $${onFile.Rent.toFixed(2)} -- MISMATCH`);
    }
    if (onFile.Deposit !== null && onFile.Deposit !== plan.security_deposit) {
      mismatches.push(
        `Security Deposit: submitted $${plan.security_deposit.toFixed(2)}, workbook has $${onFile.Deposit.toFixed(2)} -- MISMATCH`,
      );
    }
    if (onFile.Name && !plan.tenant_names.some((n) => n.trim().toLowerCase() === onFile.Name!.trim().toLowerCase())) {
      mismatches.push(
        `Tenant name: submitted "${plan.tenant_names.join(' & ')}", workbook has "${onFile.Name}" -- MISMATCH`,
      );
    }
  }

  const tenantLine = plan.tenant_names.join(' & ');
  const policy = plan.fixed_term_continuation_policy ?? 'month_to_month';
  const sigDates = plan.signature_dates ?? {};
  const sigDateLines =
    Object.keys(sigDates).length > 0
      ? `Signature dates (explicit, not inferred): ${Object.entries(sigDates)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}`
      : 'Signature dates: none supplied -- will be left blank (unsigned draft)';

  const question =
    `OUTPUT DIRECTORY (host-configured, not agent-supplied): ${DRAFTS_DIR_WIN}\n` +
    `Filename will be "<Full Property Address> Unsigned Lease.pdf" (v2/v3... appended automatically if that name ` +
    `already exists -- never overwritten).\n\n` +
    `Agent "${agentGroup.name}" wants to generate a Fixed-Term lease PDF with this data:\n\n` +
    `  Tenant(s): ${tenantLine}\n` +
    `  Property Address: ${plan.property_address}\n` +
    `  Rent: $${plan.rent.toFixed(2)}\n` +
    `  Security Deposit: $${plan.security_deposit.toFixed(2)}\n` +
    `  Lease Start Date: ${plan.lease_start_date}\n` +
    `  Lease End Date: ${plan.lease_end_date}\n` +
    `  Continuation policy: ${policy}\n` +
    `  Agreement date: ${plan.agreement_date ?? '(today, at generation time)'}\n` +
    `  ${sigDateLines}\n\n` +
    (onFile
      ? `Workbook cross-check for this address: on file as "${onFile.Name ?? '(no name)'}", ` +
        `rent ${onFile.Rent !== null ? `$${onFile.Rent.toFixed(2)}` : '(none on file)'}, ` +
        `deposit ${onFile.Deposit !== null ? `$${onFile.Deposit.toFixed(2)}` : '(none on file)'}.\n` +
        (mismatches.length > 0 ? `${mismatches.join('\n')}\n` : 'No mismatches against the workbook.\n')
      : 'Workbook cross-check: this address was not found in the Write sheet -- proceeding on the submitted data alone.\n') +
    (summary ? `\n${summary}\n` : '') +
    `\nAll standard checkboxes, landlord information, appliance rule, fees, notice periods, and lead-paint ` +
    `selections come from the frozen v1 spec -- unaffected by this request. Signature lines stay blank regardless.`;

  await requestApproval({
    session,
    agentName: agentGroup.name,
    action: 'lease_manager_generate',
    payload: { plan, summary, requestId },
    title:
      mismatches.length > 0 ? 'Lease PDF Generation Request -- MISMATCH vs. workbook' : 'Lease PDF Generation Request',
    question,
  });
}
