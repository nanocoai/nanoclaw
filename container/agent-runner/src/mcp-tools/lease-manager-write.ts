/**
 * Lease Manager write-plan submission tools -- production and test -- plus
 * the test-workbook reset tool. All fire-and-forget, same shape as
 * self-mod's install_packages: the tool writes a system action row and
 * returns immediately; the host processes it (including admin approval for
 * the two write tools) and notifies the agent via a chat message when
 * complete.
 *
 * These tools are visible to every agent's container (MCP tools register
 * globally in this codebase — there is no per-agent-group tool visibility
 * mechanism), but functionally useless to anyone but Lease Manager: the
 * host-side handlers hardcode both the target workbook path and the
 * required calling agent group, neither of which any of these tools'
 * arguments can influence. Row-shape checks here are defense-in-depth; the
 * host re-checks everything on the approved replay.
 *
 * Ported from old commit 59de60dc, adapted to await writeMessageOut (now
 * async).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const MAX_ROWS = 500;
const VALID_STATUS = new Set(['New', 'Update', 'Vacant']);
const VALID_LEASE_STATUS = new Set(['Fixed Term', 'Month-to-Month', 'Vacant']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface PlanRow {
  Name: string | null;
  Address: string;
  Rent: number | null;
  Deposit: number | null;
  Market: number | null;
  Status: string;
  // Three-state: key absent = leave unchanged, null = clear the cell, string = set it.
  LeaseStartDate?: string | null;
  LeaseEndDate?: string | null;
  LeaseReminderDate?: string | null;
  LeaseStatus?: string | null;
}

/** Three-state field check: absent is always fine (untouched); when present, must be null or a valid value. */
function isValidOptionalDate(row: Record<string, unknown>, key: string): boolean {
  if (!(key in row)) return true;
  const v = row[key];
  return v === null || (typeof v === 'string' && DATE_RE.test(v));
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
  if ('LeaseStatus' in row && row.LeaseStatus !== null && !VALID_LEASE_STATUS.has(row.LeaseStatus as string)) return false;
  return true;
}

const rowSchemaProperties = {
  Name: { type: ['string', 'null'] },
  Address: { type: 'string' },
  Rent: { type: ['number', 'null'] },
  Deposit: { type: ['number', 'null'] },
  Market: { type: ['number', 'null'] },
  Status: { type: 'string', enum: ['New', 'Update', 'Vacant'] },
  LeaseStartDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  LeaseEndDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  LeaseReminderDate: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  LeaseStatus: { type: ['string', 'null'], enum: ['Fixed Term', 'Month-to-Month', 'Vacant', null] },
} as const;

const leaseFieldRules =
  'LeaseStartDate/LeaseEndDate/LeaseReminderDate/LeaseStatus are three-state: OMIT the key to leave the ' +
  'existing cell untouched, set it to null to explicitly clear it, or set it to a value to set/update it. ' +
  'Dates are "YYYY-MM-DD". Never invent or infer a start/end date — only use what Kirk explicitly gave you or ' +
  'an approved lease document. LeaseReminderDate is normally computed by the host (60 days before ' +
  'LeaseEndDate) — omit it unless you have an explicit override instruction from Kirk. LeaseStatus="Fixed ' +
  'Term" requires LeaseEndDate to be explicitly set in the same row. Only set LeaseStatus="Month-to-Month" ' +
  'when Kirk explicitly said so, never merely because an end date is missing.';

/** Builds one submit-plan tool. Shared shape; only name/action/description differ between production and test. */
function buildSubmitTool(name: string, action: string, description: string): McpToolDefinition {
  return {
    tool: {
      name,
      description,
      inputSchema: {
        type: 'object' as const,
        properties: {
          rows: {
            type: 'array',
            maxItems: MAX_ROWS,
            items: {
              type: 'object',
              properties: rowSchemaProperties,
              required: ['Address', 'Status'],
            },
            description:
              'Fully resolved rows to write. Address is the match key; Name is confirmation only. Omit ' +
              'LeaseStartDate/LeaseEndDate/LeaseReminderDate/LeaseStatus entirely to leave them untouched.',
          },
          summary: { type: 'string', description: 'One-line human summary of what this plan does, for the approval card.' },
        },
        required: ['rows'],
      },
    },
    async handler(args) {
      const rows = args.rows as unknown[];
      if (!Array.isArray(rows) || rows.length === 0) return err('rows must be a non-empty array');
      if (rows.length > MAX_ROWS) return err(`Maximum ${MAX_ROWS} rows per write plan`);
      const badIndex = rows.findIndex((r) => !isValidRow(r));
      if (badIndex !== -1) return err(`Row ${badIndex} is malformed — check Address/Status (and Name/Rent/Deposit/Market types)`);

      const requestId = generateId();
      await writeMessageOut({
        id: requestId,
        kind: 'system',
        content: JSON.stringify({ action, rows, summary: (args.summary as string) || '' }),
      });

      log(`${action}: ${requestId} → ${rows.length} rows`);
      return ok(`Write plan submitted (${rows.length} rows). You will be notified when admin approves or rejects.`);
    },
  };
}

export const submitLeaseWritePlan = buildSubmitTool(
  'submit_lease_write_plan',
  'lease_manager_write',
  'Submit an approved-looking write plan for the LIVE Lease Manager workbook Write sheet — real tenant data, real ' +
    'consequences. Only usable by the Lease Manager agent — the host rejects calls from any other agent group. ' +
    'Requires admin approval; fire-and-forget. Rows must already be fully resolved (no ambiguous names, no ' +
    'unescalated cases) — this tool does not do any matching or cleanup itself. On approval the host makes a ' +
    'timestamped backup, applies only the Write-sheet cells for these rows via Excel, verifies the workbook still ' +
    'opens, and reports back exactly what changed. Never touches the Read sheet. Use this only for real production ' +
    'changes Kirk has actually authorized — for feature-development retests or anything experimental, use ' +
    'submit_lease_write_plan_test instead.\n\n' +
    leaseFieldRules,
);

export const submitLeaseWritePlanTest = buildSubmitTool(
  'submit_lease_write_plan_test',
  'lease_manager_write_test',
  'Submit a write plan for the SYNTHETIC TEST workbook — fictional data, zero real-world consequences, entirely ' +
    'separate from the live workbook. Use this for any feature-development retest Kirk explicitly asks for, or any ' +
    'experimentation with the write mechanism itself. Same approval/backup/apply/verify pipeline as the production ' +
    'tool, same row rules, but the approval card is clearly marked TEST and nothing here ever touches real tenant ' +
    'data. Call reset_lease_test_workbook between test runs to restore a clean baseline.\n\n' + leaseFieldRules,
);

export const resetLeaseTestWorkbookTool: McpToolDefinition = {
  tool: {
    name: 'reset_lease_test_workbook',
    description:
      'Reset the synthetic test workbook to its clean fictional baseline. No arguments, no approval needed — this ' +
      'can only ever affect the test workbook, never the live one. Call this between test iterations so each test ' +
      'run starts from a known state.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'reset_lease_test_workbook' }),
    });
    log(`reset_lease_test_workbook: ${requestId}`);
    return ok('Test workbook reset requested.');
  },
};

registerTools([submitLeaseWritePlan, submitLeaseWritePlanTest, resetLeaseTestWorkbookTool]);
