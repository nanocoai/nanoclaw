/**
 * Synthetic tests for the lease_manager_generate precheck + hold builder.
 *
 * Scoped deliberately to validateLeaseManagerGenerate and
 * requestLeaseManagerGenerateHold only -- applyLeaseManagerGenerate shells
 * out to a real Python generator (execFileAsync against PYTHON_BIN), which
 * this codebase has never covered with a test (see
 * lease-manager-write/lease-fields.test.ts, which draws the same line
 * around its own PowerShell shell-out). WORKBOOK_PATH_WSL is mocked to a
 * synthetic .xlsx built with the real xlsx package -- no test ever reads
 * the real Lease Manager workbook.
 *
 * Ported from old commit 59de60dc, adapted from the pre-async central DB
 * and sync createAgentGroup/getSession/guard/validateLeaseManagerGenerate
 * to their current async equivalents -- no behavior change, and the same
 * deliberate no-apply-test boundary preserved.
 */
import * as fs from 'fs';
import * as path from 'path';
import XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { guard } from '../../guard/index.js';
import { writeSessionMessage } from '../../session-manager.js';
import { requestApproval } from '../approvals/index.js';
import type { Session } from '../../types.js';
import type { GenerationPlan } from './request.js';

const TEST_WORKBOOK_DIR = '/tmp/nanoclaw-test-lease-manager-generate-workbook';
const TEST_WORKBOOK_PATH = path.join(TEST_WORKBOOK_DIR, 'workbook.xlsx');

const LEASE_MANAGER_AGENT_GROUP_ID = 'ag-8384e334-f3d2-4430-b77e-67b359f09beb';
const OTHER_AGENT_GROUP_ID = 'ag-some-other-agent';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../approvals/index.js', async () => {
  const actual = await vi.importActual<typeof import('../approvals/index.js')>('../approvals/index.js');
  return { ...actual, requestApproval: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, WORKBOOK_PATH_WSL: '/tmp/nanoclaw-test-lease-manager-generate-workbook/workbook.xlsx' };
});

import { leaseManagerGenerate } from './guard.js';
import { validateLeaseManagerGenerate, requestLeaseManagerGenerateHold } from './request.js';

function now(): string {
  return new Date().toISOString();
}

function lastNotifiedText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

/** Write-sheet columns per request.ts's readWorkbookRow: A=Name, B=Address, C=Rent, D=Deposit, J=LeaseStatus. */
function writeWorkbook(
  rows: Array<{ name: string; address: string; rent?: number; deposit?: number; status?: string }>,
): void {
  fs.mkdirSync(TEST_WORKBOOK_DIR, { recursive: true });
  const header = ['Name', 'Address', 'Rent', 'Deposit', '', '', '', '', '', 'LeaseStatus'];
  const grid: (string | number | null)[][] = [header];
  for (const r of rows) {
    grid.push([r.name, r.address, r.rent ?? null, r.deposit ?? null, null, null, null, null, null, r.status ?? null]);
  }
  const ws = XLSX.utils.aoa_to_sheet(grid);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Write');
  XLSX.writeFile(wb, TEST_WORKBOOK_PATH);
}

function validPlan(overrides: Partial<GenerationPlan> = {}): GenerationPlan {
  return {
    tenant_names: ['Jane Doe'],
    property_address: '123 Synthetic St',
    rent: 1500,
    security_deposit: 1500,
    lease_start_date: '01/01/2027',
    lease_end_date: '12/31/2027',
    ...overrides,
  };
}

let leaseManagerSession: Session;
let otherAgentSession: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_WORKBOOK_DIR)) fs.rmSync(TEST_WORKBOOK_DIR, { recursive: true, force: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({
    id: LEASE_MANAGER_AGENT_GROUP_ID,
    name: 'Lease Manager',
    folder: 'lease-manager',
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: OTHER_AGENT_GROUP_ID,
    name: 'Some Other Agent',
    folder: 'some-other-agent',
    agent_provider: null,
    created_at: now(),
  });

  await createMessagingGroup({
    id: 'mg-lm',
    channel_type: 'agent',
    platform_id: 'agent:lease-manager',
    name: 'Lease Manager internal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });

  await createSession({
    id: 'sess-lm',
    agent_group_id: LEASE_MANAGER_AGENT_GROUP_ID,
    messaging_group_id: 'mg-lm',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  leaseManagerSession = (await getSession('sess-lm'))!;

  await createSession({
    id: 'sess-other',
    agent_group_id: OTHER_AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  otherAgentSession = (await getSession('sess-other'))!;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_WORKBOOK_DIR)) fs.rmSync(TEST_WORKBOOK_DIR, { recursive: true, force: true });
});

describe('guard: leaseManagerGenerate', () => {
  it("holds unconditionally from the container path -- agent-group check is the precheck's job", async () => {
    expect(
      (
        await guard(leaseManagerGenerate, {
          actor: { kind: 'agent', agentGroupId: LEASE_MANAGER_AGENT_GROUP_ID },
          payload: {},
          grant: null,
        })
      ).effect,
    ).toBe('hold');
    expect(
      (
        await guard(leaseManagerGenerate, {
          actor: { kind: 'agent', agentGroupId: OTHER_AGENT_GROUP_ID },
          payload: {},
          grant: null,
        })
      ).effect,
    ).toBe('hold');
  });

  it('denies a non-agent actor', async () => {
    expect(
      (await guard(leaseManagerGenerate, { actor: { kind: 'human', userId: 'u1' }, payload: {}, grant: null })).effect,
    ).toBe('deny');
  });
});

describe('validateLeaseManagerGenerate', () => {
  it('rejects a non-Lease-Manager caller', async () => {
    expect(await validateLeaseManagerGenerate({ plan: validPlan() }, otherAgentSession)).toBe(false);
    expect(lastNotifiedText()).toContain('not permitted for this agent');
  });

  it('rejects a malformed plan (missing required fields)', async () => {
    expect(await validateLeaseManagerGenerate({ plan: { property_address: 'x' } }, leaseManagerSession)).toBe(false);
    expect(lastNotifiedText()).toContain('plan is malformed');
  });

  it('rejects a plan with an invalid date format', async () => {
    const plan = validPlan({ lease_start_date: '2027-01-01' });
    expect(await validateLeaseManagerGenerate({ plan }, leaseManagerSession)).toBe(false);
  });

  it('rejects 0 or 3+ tenant names', async () => {
    expect(await validateLeaseManagerGenerate({ plan: validPlan({ tenant_names: [] }) }, leaseManagerSession)).toBe(
      false,
    );
    expect(
      await validateLeaseManagerGenerate(
        { plan: validPlan({ tenant_names: ['A', 'B', 'C'] }) },
        leaseManagerSession,
      ),
    ).toBe(false);
  });

  it('passes a well-formed plan with no workbook entry on file', async () => {
    writeWorkbook([]);
    expect(await validateLeaseManagerGenerate({ plan: validPlan() }, leaseManagerSession)).toBe(true);
  });

  it('passes a well-formed plan when the workbook has no matching row', async () => {
    writeWorkbook([{ name: 'Someone Else', address: '999 Other Ave', status: 'Fixed-Term' }]);
    expect(await validateLeaseManagerGenerate({ plan: validPlan() }, leaseManagerSession)).toBe(true);
  });

  it('hard-rejects when the workbook shows this address as Month-to-Month', async () => {
    writeWorkbook([{ name: 'Jane Doe', address: '123 Synthetic St', status: 'Month-to-Month' }]);
    expect(await validateLeaseManagerGenerate({ plan: validPlan() }, leaseManagerSession)).toBe(false);
    expect(lastNotifiedText()).toContain('Month-to-Month');
  });

  it('passes when the workbook shows this address as Fixed-Term (not Month-to-Month)', async () => {
    writeWorkbook([{ name: 'Jane Doe', address: '123 Synthetic St', status: 'Fixed-Term' }]);
    expect(await validateLeaseManagerGenerate({ plan: validPlan() }, leaseManagerSession)).toBe(true);
  });

  it('does not throw and treats a missing/unreadable workbook as no cross-check data', async () => {
    // TEST_WORKBOOK_DIR never created -- XLSX.readFile throws, caught and logged.
    expect(await validateLeaseManagerGenerate({ plan: validPlan() }, leaseManagerSession)).toBe(true);
  });
});

describe('requestLeaseManagerGenerateHold', () => {
  it('builds an approval card with the full field set and no mismatch banner when nothing is on file', async () => {
    writeWorkbook([]);
    await requestLeaseManagerGenerateHold({ plan: validPlan(), summary: 'test summary' }, leaseManagerSession);

    expect(requestApproval).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(requestApproval).mock.calls[0][0];
    expect(opts.action).toBe('lease_manager_generate');
    expect(opts.title).toBe('Lease PDF Generation Request');
    expect(opts.question).toContain('Jane Doe');
    expect(opts.question).toContain('123 Synthetic St');
    expect(opts.question).toContain('$1500.00');
    expect(opts.question).toContain('was not found in the Write sheet');
    expect(opts.question).toContain('test summary');
    expect((opts.payload as { plan: GenerationPlan }).plan).toEqual(validPlan());
  });

  it('flags the title and body when submitted data mismatches the workbook', async () => {
    writeWorkbook([{ name: 'Jane Doe', address: '123 Synthetic St', rent: 1800, deposit: 1500, status: 'Fixed-Term' }]);
    await requestLeaseManagerGenerateHold({ plan: validPlan(), summary: '' }, leaseManagerSession);

    const opts = vi.mocked(requestApproval).mock.calls[0][0];
    expect(opts.title).toContain('MISMATCH');
    expect(opts.question).toContain('Rent: submitted $1500.00, workbook has $1800.00 -- MISMATCH');
    expect(opts.question).not.toContain('Security Deposit: submitted');
  });

  it('reports no mismatches when submitted data matches the workbook exactly', async () => {
    writeWorkbook([{ name: 'Jane Doe', address: '123 Synthetic St', rent: 1500, deposit: 1500, status: 'Fixed-Term' }]);
    await requestLeaseManagerGenerateHold({ plan: validPlan(), summary: '' }, leaseManagerSession);

    const opts = vi.mocked(requestApproval).mock.calls[0][0];
    expect(opts.title).toBe('Lease PDF Generation Request');
    expect(opts.question).toContain('No mismatches against the workbook.');
  });
});
