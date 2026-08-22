/**
 * Lease Manager PDF-generation submission tool -- fire-and-forget, same
 * shape as lease-manager-write's submit_lease_write_plan: the tool writes a
 * system action row and returns immediately; the host processes it
 * (including admin approval) and notifies the agent via a chat message when
 * complete.
 *
 * This tool is visible to every agent's container (MCP tools register
 * globally in this codebase -- there is no per-agent-group tool visibility
 * mechanism), but functionally useless to anyone but Lease Manager: the
 * host-side handler hardcodes the required calling agent group. There is no
 * argument anywhere in this schema for an output path, directory, or
 * filename -- the host alone decides where a generated PDF is written and
 * what it's named (Leases/Drafts, "<Full Property Address> Unsigned
 * Lease.pdf", versioned v2/v3/... if that name is already taken, never
 * overwritten). Plan-shape checks here are defense-in-depth; the host
 * re-checks everything on the approved replay.
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

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

interface GenerationPlan {
  tenant_names: string[];
  property_address: string;
  rent: number;
  security_deposit: number;
  lease_start_date: string;
  lease_end_date: string;
  fixed_term_continuation_policy?: 'month_to_month' | 'must_vacate';
  agreement_date?: string;
  signature_dates?: { tenant1?: string; tenant2?: string };
}

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
  if (row.fixed_term_continuation_policy !== undefined && row.fixed_term_continuation_policy !== 'month_to_month' && row.fixed_term_continuation_policy !== 'must_vacate') return false;
  if (row.agreement_date !== undefined && (typeof row.agreement_date !== 'string' || !DATE_RE.test(row.agreement_date))) return false;
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

export const submitLeaseGenerationPlan: McpToolDefinition = {
  tool: {
    name: 'submit_lease_generation_plan',
    description:
      'Submit an approved-looking Fixed-Term lease PDF generation request. Only usable by the Lease Manager ' +
      'agent -- the host rejects calls from any other agent group. Requires admin approval; fire-and-forget. ' +
      'This tool takes lease DATA ONLY -- there is no field for an output path, directory, or filename anywhere ' +
      'in this schema, and none will be honored if you somehow include one; the host alone decides where the PDF ' +
      'is written and what it is named. Fixed-Term only for v1 -- if the workbook shows this address as ' +
      'Month-to-Month, the request is rejected before any approval card is created. Every field you submit must ' +
      'be something Kirk explicitly told you or something you read directly from the workbook -- never guess or ' +
      'infer a missing value (especially rent, security_deposit, or dates); if something required is missing or ' +
      'conflicts with the workbook, ask Kirk via Pepper first and do not call this tool yet. Signature lines are ' +
      'always left blank; signature_dates are optional and only set if Kirk explicitly gave you a date -- never ' +
      'infer one from today\'s date or lease_start_date. tenant1/tenant2/landlord are three INDEPENDENT dates -- ' +
      'the landlord date is never copied from a tenant date and vice versa. If the landlord and a tenant signed ' +
      'on different days, set both dates to their own real values; if you only know one of them, set only that ' +
      'one and leave the other blank -- never assume they match.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        plan: {
          type: 'object',
          additionalProperties: false,
          properties: {
            tenant_names: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 2,
              description: 'Tenant full name(s), 1 or 2. Joined with " & " on the combined line; each also gets its own printed-name field.',
            },
            property_address: { type: 'string', description: 'Full address including city, state, and ZIP.' },
            rent: { type: 'number', description: 'Monthly rent. Prefer the workbook value for this address when available.' },
            security_deposit: { type: 'number', description: 'Security deposit. Prefer the workbook value for this address when available.' },
            lease_start_date: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: 'MM/DD/YYYY' },
            lease_end_date: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: 'MM/DD/YYYY' },
            fixed_term_continuation_policy: { type: 'string', enum: ['month_to_month', 'must_vacate'], description: 'Defaults to month_to_month if omitted -- the frozen v1 default.' },
            agreement_date: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: 'Optional. Defaults to the actual generation date if omitted -- do not set this yourself unless Kirk gave an explicit date.' },
            signature_dates: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tenant1: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: "Tenant 1's own signing date. Independent of landlord's -- do not copy one to the other." },
                tenant2: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: "Tenant 2's own signing date. Independent of tenant1's and landlord's." },
                landlord: { type: 'string', pattern: '^\\d{2}/\\d{2}/\\d{4}$', description: "The landlord's (Kirk's) own signing date, for pages 9 and 11. Independent of the tenant date(s) -- do not copy a tenant date here." },
              },
              description: 'Omit entirely for an unsigned draft. Only set a key if Kirk explicitly supplied that specific date -- never inferred, and never mirrored from one signer to another.',
            },
          },
          required: ['tenant_names', 'property_address', 'rent', 'security_deposit', 'lease_start_date', 'lease_end_date'],
        },
        summary: { type: 'string', description: 'One-line human summary for the approval card (optional).' },
      },
      required: ['plan'],
    },
  },
  async handler(args) {
    const plan = args.plan;
    if (!isValidPlan(plan)) {
      return err(
        'plan is malformed -- check tenant_names (1-2 non-empty strings), property_address, rent/security_deposit ' +
          '(numbers), lease_start_date/lease_end_date (MM/DD/YYYY), and optional ' +
          'fixed_term_continuation_policy/agreement_date/signature_dates',
      );
    }

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'lease_manager_generate', plan, summary: (args.summary as string) || '' }),
    });

    log(`lease_manager_generate: ${requestId} -> ${plan.property_address}`);
    return ok('Lease generation plan submitted. You will be notified when admin approves or rejects.');
  },
};

registerTools([submitLeaseGenerationPlan]);
