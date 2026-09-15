/**
 * Approval restart honesty: rows survive the process, resolution is
 * row-keyed, re-attach never duplicates a card, and expiry is row-driven.
 * The gateway is consumed through the provider seam — these tests inject a
 * fake provider and exercise every capability combination.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-restart-honesty' };
});

vi.mock('./primitive.js', () => ({
  pickApprover: vi.fn().mockResolvedValue(['telegram:admin']),
  pickApprovalDelivery: vi.fn().mockResolvedValue({
    userId: 'telegram:admin',
    messagingGroup: { channel_type: 'telegram', platform_id: 'D-1', instance: null },
  }),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import {
  resetGatewayProvider,
  type GatewayApprovalDecision,
  type GatewayApprovalRequest,
  type GatewayProviderDefinition,
} from '../../gateway-providers/index.js';
import type { PendingApproval } from '../../types.js';
import {
  GATEWAY_APPROVAL_ACTION,
  handleGatewayApprovalResponse,
  startGatewayApprovalCoordinator,
  stopGatewayApprovalCoordinator,
} from '../../gateway-approval-coordinator.js';

const TEST_DIR = '/tmp/nanoclaw-test-restart-honesty';

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface DeliveredCall {
  kind: string;
  content: string;
}
const delivered: DeliveredCall[] = [];
const captureAdapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, _platformId, _threadId, kind, content) {
    delivered.push({ kind, content });
    return 'pm-out';
  },
};

let capturedHandler: ((request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>) | null = null;
const source: GatewayProviderDefinition['approvals'] & {
  decide?: ReturnType<typeof vi.fn>;
  listPending?: ReturnType<typeof vi.fn>;
} = {
  async subscribe(handler, signal) {
    capturedHandler = handler;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  },
};

const fakeProvider: GatewayProviderDefinition = {
  kind: 'fake-for-tests',
  agentSkills: [],
  sessions: {
    async ensure() {
      throw new Error('not under test');
    },
  },
  approvals: source,
};

async function resolveApproval(questionId: string, value: string): Promise<boolean> {
  return handleGatewayApprovalResponse({
    questionId,
    value,
    userId: 'telegram:admin',
    channelType: 'telegram',
    platformId: 'D-1',
    threadId: null,
  });
}

vi.mock('./response-handler.js', () => ({ isAuthorizedApprovalClick: async () => true }));

async function seedRow(overrides: Partial<PendingApproval> = {}): Promise<PendingApproval> {
  const row: PendingApproval = {
    approval_id: 'oa-test0001',
    session_id: null,
    request_id: 'req-1',
    action: GATEWAY_APPROVAL_ACTION,
    payload: JSON.stringify({ gatewayProvider: 'fake-for-tests' }),
    created_at: iso(-60_000),
    agent_group_id: 'ag-1',
    channel_type: 'telegram',
    platform_id: 'D-1',
    instance: null,
    platform_message_id: 'pm-1',
    expires_at: iso(120_000),
    status: 'pending',
    title: 'Credentials Request',
    question: 'Allow this request?',
    options_json: '[]',
    approver_user_id: 'telegram:admin',
    ...overrides,
  };
  await createPendingApproval(row);
  return row;
}

beforeEach(async () => {
  vi.clearAllMocks();
  delivered.length = 0;
  capturedHandler = null;
  delete source.decide;
  delete source.listPending;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: iso(0) });
  resetGatewayProvider(fakeProvider);
});

afterEach(async () => {
  await stopGatewayApprovalCoordinator();
  resetGatewayProvider(null);
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('row-keyed resolution after a restart', () => {
  it('a surviving still-open card is decidable; approve carries the retry caveat', async () => {
    await seedRow();
    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());

    // No in-memory state exists for this row — exactly the post-restart shape.
    expect(await resolveApproval('oa-test0001', 'approve')).toBe(true);
    expect(await getPendingApproval('oa-test0001')).toBeUndefined();

    const edit = delivered.find((call) => call.content.includes('retry'));
    expect(edit, 'approve without a gateway decide path must tell the human to have the agent retry').toBeDefined();
  });

  it('a late reject needs no caveat edit — the auto-edited card is already honest', async () => {
    await seedRow();
    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());

    expect(await resolveApproval('oa-test0001', 'reject')).toBe(true);
    expect(await getPendingApproval('oa-test0001')).toBeUndefined();
    expect(delivered).toHaveLength(0);
  });

  it('a late decision rides the gateway decide capability when present', async () => {
    source.decide = vi.fn().mockResolvedValue(true);
    await seedRow();
    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());

    expect(await resolveApproval('oa-test0001', 'approve')).toBe(true);
    expect(source.decide).toHaveBeenCalledWith('req-1', 'approve');
    // Delivered to the gateway — no caveat follow-up needed.
    expect(delivered).toHaveLength(0);
  });

  it('a second click loses the row transition and reports unresolved', async () => {
    await seedRow();
    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());
    expect(await resolveApproval('oa-test0001', 'approve')).toBe(true);
    expect(await resolveApproval('oa-test0001', 'reject')).toBe(false);
  });
});

describe('re-attach at startup', () => {
  it('expires overdue rows honestly and keeps still-open rows decidable', async () => {
    await seedRow({
      approval_id: 'oa-overdue1',
      request_id: 'req-old',
      expires_at: iso(-5_000),
      platform_message_id: 'pm-old',
    });
    await seedRow({ approval_id: 'oa-alive001', request_id: 'req-new', expires_at: iso(120_000) });

    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());

    await vi.waitFor(async () => {
      expect(await getPendingApproval('oa-overdue1')).toBeUndefined();
    });
    const timeoutEdit = delivered.find((call) => call.content.includes('Timed out — no response'));
    expect(timeoutEdit).toBeDefined();
    expect(await getPendingApproval('oa-alive001')).toBeDefined();
  });

  it('consults listPending when the gateway can enumerate held requests', async () => {
    source.listPending = vi.fn().mockResolvedValue([{ id: 'req-1' }]);
    await seedRow();
    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());
    await vi.waitFor(() => expect(source.listPending).toHaveBeenCalled());
    expect(await getPendingApproval('oa-test0001')).toBeDefined();
  });
});

describe('reconnect dedupe', () => {
  it('a redelivered request re-arms the existing card — never a duplicate', async () => {
    await seedRow({ request_id: 'req-9' });
    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());
    expect(capturedHandler).not.toBeNull();

    const decisionPromise = capturedHandler!({
      id: 'req-9',
      expiresAt: iso(120_000),
      agentGroupId: 'ag-1',
      createdAt: iso(0),
      title: 'Credentials Request',
      question: 'Allow POST api.example.com/send?',
    });
    // Let the asynchronous DB reads re-arm the callback before clicking the card.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.waitFor(async () => {
      expect(await resolveApproval('oa-test0001', 'approve')).toBe(true);
    });
    await expect(decisionPromise).resolves.toBe('approve');
    // No ask_question card was delivered for the redelivery.
    expect(delivered.filter((call) => call.content.includes('ask_question'))).toHaveLength(0);
  });

  it('a genuinely new request cards once and stamps the routed approver', async () => {
    await startGatewayApprovalCoordinator(fakeProvider, captureAdapter, vi.fn());
    const decisionPromise = capturedHandler!({
      id: 'req-fresh',
      expiresAt: iso(120_000),
      agentGroupId: 'ag-1',
      createdAt: iso(0),
      title: 'Credentials Request',
      question: 'Allow POST api.example.com/send?',
    });

    let approvalId = '';
    await vi.waitFor(() => {
      const card = delivered.find((call) => call.content.includes('ask_question'));
      expect(card).toBeDefined();
      approvalId = (JSON.parse(card!.content) as { questionId: string }).questionId;
    });
    const row = await getPendingApproval(approvalId);
    expect(row?.approver_user_id).toBe('telegram:admin');
    expect(row?.request_id).toBe('req-fresh');

    expect(await resolveApproval(approvalId, 'reject')).toBe(true);
    await expect(decisionPromise).resolves.toBe('deny');
  });
});
