import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDeliveryAdapter } from '../delivery.js';
import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';
import type { MessagingGroup } from '../types.js';
import type {
  ApprovalDecision,
  ApprovalEvent,
  ApprovalSnapshot,
  DecisionCommand,
  GatewayApproval,
} from './approval-contract.js';
import { parseApprovalSnapshot } from './approval-contract.js';
import { APPROVAL_CARD_TITLE_LIMIT, APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT } from './approval-card-render.js';
import { GatewayApprovalCards, type ApprovalCardDependencies } from './approval-cards.js';
import { GatewayApprovalStore } from './approval-store.js';
import type { DecisionSubmission, GatewayApprovalTransport } from './approval-transport.js';
import { GatewayApprovalAdapter } from './gateway-approval-adapter.js';

const DEPLOYMENT = 'deployment-1';
const EPOCH = 'gw_0123456789abcdef0123456789abcdef';

let db: DbDriver;
let store: GatewayApprovalStore;

beforeEach(async () => {
  db = await initTestDb();
  await runMigrations(db);
  store = new GatewayApprovalStore(db, DEPLOYMENT);
  await insertUser('slack:approver-1');
  await insertUser('slack:other-admin');
});

afterEach(async () => closeDb());

describe('Gateway approval storage and cards', () => {
  it('enforces one explicit user binding for each immutable IdP principal', async () => {
    await store.replaceApproverBinding('https://idp.example.com', 'subject-1', 'slack:approver-1');
    expect(await store.resolveApprover('https://idp.example.com', 'subject-1')).toEqual({
      status: 'unique',
      userId: 'slack:approver-1',
    });

    await expect(
      db.run(
        `INSERT INTO nanoco_approver_bindings (issuer, subject, user_id, created_at)
         VALUES (?, ?, ?, ?)`,
        'https://idp.example.com',
        'subject-1',
        'slack:other-admin',
        new Date().toISOString(),
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('commits one row and sends one short-identity card under concurrent duplicate delivery', async () => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    await db.run(
      'UPDATE nanoco_gateway_approvals SET card_title = ? WHERE card_question_id = ?',
      'Persisted approval title',
      row.card_question_id,
    );
    let releaseDm!: () => void;
    const dmGate = new Promise<void>((resolve) => {
      releaseDm = resolve;
    });
    const deliver = vi.fn(async (..._args: Parameters<ChannelDeliveryAdapter['deliver']>) => 'platform-message-1');
    const cards = cardsWith({
      resolveBinding: { resolveApprover: async () => ({ status: 'unique', userId: 'slack:approver-1' }) },
      resolveDm: async () => {
        await dmGate;
        return dm();
      },
      deliveryAdapter: () => ({ deliver }),
    });

    const first = cards.deliver(row);
    const second = cards.deliver(row);
    releaseDm();
    await Promise.all([first, second]);

    expect(deliver).toHaveBeenCalledTimes(1);
    const deliveredContent = JSON.parse(deliver.mock.calls[0]![4] as string) as { title: string; question: string };
    expect(deliveredContent.title).toBe('Persisted approval title');
    expect(deliveredContent.question).toBe(
      [
        '✏️ *Write operation*',
        "Send a new email on the user's behalf.",
        '*To*\n• alice@example.com',
        '*Subject*\nQuarterly plan',
        '*Message preview*\n> Ship the small version.',
        '_Approval expires: 23 Jul 2099, 00:00 UTC_',
      ].join('\n\n'),
    );
    expect(deliveredContent.question).not.toContain('Body shape');
    expect(deliveredContent.question).not.toContain('https://api.example.com');
    const stored = (await store.getByQuestionId(row.card_question_id))!;
    expect(stored.state).toBe('pending');
    expect(stored.card_attempted_at).not.toBeNull();
    expect(stored.card_delivered_at).not.toBeNull();
    expect(stored.card_platform_message_id).toBe('platform-message-1');
    expect(`ncq:${stored.card_question_id}:1`.length).toBeLessThanOrEqual(64);

    // Snapshot reconciliation reuses the persisted card; it never emits a
    // replacement while the same Gateway request remains active.
    expect(await store.reconcileSnapshot(snapshot())).toEqual([]);
    await cards.deliver(stored);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['CJK', '漢'.repeat(85), '語'.repeat(85)],
    ['emoji graphemes', '👩🏽‍💻'.repeat(17), '👨‍👩‍👧‍👦'.repeat(10)],
    ['worst-case escapable', '&'.repeat(256), '&'.repeat(256)],
  ])('delivers a contract-valid %s title without failing the persisted wire check', async (_, appLabel, title) => {
    await store.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:approver-1');
    const approval = makeApproval();
    approval.presentation = { ...approval.presentation, appLabel, title };
    const row = (await store.reconcileSnapshot(parseApprovalSnapshot(snapshot(0, [approval]), DEPLOYMENT)))[0]!;
    const deliver = vi.fn(async (..._args: Parameters<ChannelDeliveryAdapter['deliver']>) => 'unicode-card-1');
    const cards = cardsWith({
      resolveBinding: store,
      resolveDm: async () => dm(),
      deliveryAdapter: () => ({ deliver }),
    });

    await cards.deliver(row);

    expect(deliver).toHaveBeenCalledOnce();
    expect(graphemes(row.card_title).length).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_LIMIT);
    expect(Buffer.byteLength(row.card_title)).toBeLessThanOrEqual(APPROVAL_CARD_TITLE_UTF8_BYTE_LIMIT);
    expect(row.card_title).toMatch(/…$/);
    const content = JSON.parse(deliver.mock.calls[0]![4] as string) as { title: string; question: string };
    expect(content.title).toBe(row.card_title);
    if (appLabel.startsWith('&')) {
      expect(content.question).toContain('&amp;'.repeat(256));
      expect(content.question).toContain('*Full approval title*\n```');
    } else {
      expect(content.question).toContain(`${appLabel} · ${title}`);
    }
    expect(await store.getByQuestionId(row.card_question_id)).toMatchObject({
      state: 'pending',
      card_delivered_at: expect.any(String),
      card_platform_message_id: 'unicode-card-1',
    });
  });

  it.each([
    ['missing', { status: 'missing' } as const],
    ['ambiguous', { status: 'ambiguous' } as const],
  ])('fails %s bindings closed before delivery', async (_name, resolution) => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    const deliver = vi.fn();
    const ready = vi.fn();
    const cards = cardsWith({
      resolveBinding: { resolveApprover: async () => resolution },
      resolveDm: vi.fn(),
      deliveryAdapter: () => ({ deliver }),
      decisionReady: ready,
    });
    await cards.deliver(row);

    const stored = (await store.getByQuestionId(row.card_question_id))!;
    expect(stored.state).toBe('decided');
    expect(stored.decision).toBe('unavailable');
    expect(deliver).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledOnce();
  });

  it('fails an unreachable selected user closed without choosing another admin', async () => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    const resolveDm = vi.fn(async () => null);
    const cards = cardsWith({
      resolveBinding: { resolveApprover: async () => ({ status: 'unique', userId: 'slack:approver-1' }) },
      resolveDm,
    });
    await cards.deliver(row);

    expect(resolveDm).toHaveBeenCalledWith('slack:approver-1');
    expect(await store.getByQuestionId(row.card_question_id)).toMatchObject({
      state: 'decided',
      decision: 'unavailable',
      approver_user_id: null,
    });
  });

  it('records a card rendering or delivery failure as unavailable, never approved', async () => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    const deliver = vi.fn(async () => {
      throw new Error('platform rejected rendered card');
    });
    const ready = vi.fn();
    const cards = cardsWith({
      resolveBinding: { resolveApprover: async () => ({ status: 'unique', userId: 'slack:approver-1' }) },
      resolveDm: async () => dm(),
      deliveryAdapter: () => ({ deliver }),
      decisionReady: ready,
    });

    await cards.deliver(row);

    expect(deliver).toHaveBeenCalledOnce();
    expect(await store.getByQuestionId(row.card_question_id)).toMatchObject({
      state: 'decided',
      decision: 'unavailable',
      card_delivered_at: null,
    });
    expect(await store.decisionsToSubmit(EPOCH)).toEqual([
      expect.objectContaining({ approval_id: row.approval_id, decision: 'unavailable' }),
    ]);
    expect(ready).toHaveBeenCalledOnce();
  });

  it('turns only an uncertain pre-attempt restart window into durable unavailable', async () => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    await store.recordCardAddress(key(row), 'slack:approver-1', {
      channelType: 'slack',
      platformId: 'D-approver-1',
    });
    await store.markCardAttempted(key(row));

    expect(await store.uncertainCardAttempts(EPOCH)).toHaveLength(1);
    for (const uncertain of await store.uncertainCardAttempts(EPOCH)) await store.recordUnavailable(key(uncertain));
    expect(await store.decisionsToSubmit(EPOCH)).toEqual([
      expect.objectContaining({ approval_id: row.approval_id, decision: 'unavailable', state: 'decided' }),
    ]);
  });

  it('rejects changed duplicate evidence and applies each event cursor atomically', async () => {
    await store.reconcileSnapshot(snapshot(4));
    const approval = makeApproval();
    expect(await store.recordEvent(requestedEvent(5, approval))).toMatchObject({
      event_id: 5,
      approval_id: approval.approvalId,
    });
    expect(await store.cursor()).toEqual({ gateway_epoch: EPOCH, cursor: 5 });
    expect(await store.recordEvent(requestedEvent(5, approval))).toBeNull();

    const changed = { ...approval, summary: { ...approval.summary, path: '/changed' } };
    await expect(store.recordEvent(requestedEvent(6, changed))).rejects.toThrow(/immutable approval evidence/);
    expect(await store.cursor()).toEqual({ gateway_epoch: EPOCH, cursor: 5 });
  });

  it('rejects a same-epoch snapshot cursor regression without changing durable state', async () => {
    const row = (await store.reconcileSnapshot(snapshot(9)))[0]!;
    await expect(store.reconcileSnapshot(snapshot(8, []))).rejects.toThrow(/cursor regressed/);
    expect(await store.cursor()).toEqual({ gateway_epoch: EPOCH, cursor: 9 });
    expect((await store.get(key(row)))?.state).toBe('pending');
  });

  it('keeps decided same-epoch rows for receipt retry but expires pending absences and old epochs', async () => {
    await store.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:approver-1');
    const pending = (await store.reconcileSnapshot(snapshot()))[0]!;
    await store.recordCardAddress(key(pending), 'slack:approver-1', {
      channelType: 'slack',
      platformId: 'D-approver-1',
    });
    expect((await store.recordHumanDecision(pending.card_question_id, 'slack:approver-1', 'approve')).status).toBe(
      'decided',
    );

    await store.reconcileSnapshot(snapshot(0, []));
    expect((await store.get(key(pending)))?.state).toBe('decided');

    await store.reconcileSnapshot({ ...snapshot(0, []), gatewayEpoch: 'gw_new_epoch_0123456789abcdef' });
    expect((await store.get(key(pending)))?.state).toBe('expired');
  });

  it('records the matching terminal event before the unavailable PUT response without losing acknowledgement', async () => {
    const row = (await store.reconcileSnapshot(snapshot(8)))[0]!;
    const decided = (await store.recordUnavailable(key(row)))!;
    expect(decided.state).toBe('decided');

    await store.recordEvent(terminalEvent(9, makeApproval(), 'cancelled'));
    expect(await store.get(key(row))).toMatchObject({
      state: 'delivered',
      decision: 'unavailable',
      gateway_state: 'cancelled',
    });

    // The idempotent HTTP response may arrive after the SSE terminal event.
    await expect(
      store.acknowledge(decided, {
        version: 'nanoco.approval.v2',
        gatewayEpoch: EPOCH,
        approvalId: row.approval_id,
        status: 'applied',
        state: 'cancelled',
      }),
    ).resolves.toBeUndefined();
  });

  it('stores every JavaScript timestamp in canonical ISO-8601 UTC form', async () => {
    await store.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:approver-1');
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    const cards = cardsWith({
      resolveBinding: { resolveApprover: async () => ({ status: 'unique', userId: 'slack:approver-1' }) },
      resolveDm: async () => dm(),
      deliveryAdapter: () => ({ deliver: async () => undefined }),
    });
    await cards.deliver(row);
    await store.recordHumanDecision(row.card_question_id, 'slack:approver-1', 'reject');

    const stored = (await store.getByQuestionId(row.card_question_id))!;
    for (const timestamp of [
      stored.created_at,
      stored.updated_at,
      stored.card_attempted_at,
      stored.card_delivered_at,
      stored.decision_at,
    ]) {
      expect(timestamp).not.toBeNull();
      expect(new Date(timestamp!).toISOString()).toBe(timestamp);
    }
  });
});

describe('Gateway approval click authorization and decision durability', () => {
  it('rejects missing/wrong users and persists the selected human decision before network submission', async () => {
    await store.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:approver-1');
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    await store.recordCardAddress(key(row), 'slack:approver-1', {
      channelType: 'slack',
      platformId: 'D-approver-1',
    });
    await store.markCardAttempted(key(row));
    await store.recordCardDelivered(key(row), 'message-1');

    const submitted: DecisionCommand[] = [];
    const transport = fakeTransport({
      submit: async (command) => {
        expect((await store.get(key(row)))?.state).toBe('decided');
        submitted.push(command);
        return {
          status: 'acknowledged',
          acknowledgement: {
            version: 'nanoco.approval.v2',
            gatewayEpoch: EPOCH,
            approvalId: row.approval_id,
            status: 'applied',
            state: 'approved',
          },
        };
      },
    });
    const adapter = adapterWith(transport);

    await adapter.handleClick(click(row.card_question_id, 'slack', null, 'approve'));
    await adapter.handleClick(click(row.card_question_id, 'slack', 'other-admin', 'approve'));
    expect((await store.get(key(row)))?.state).toBe('pending');
    expect(submitted).toHaveLength(0);

    await adapter.handleClick(click(row.card_question_id, 'slack', 'approver-1', 'approve'));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      approvalId: row.approval_id,
      decision: 'approve',
      approver: { issuer: 'https://idp.example.com', subject: 'stable-idp-subject' },
    });
    expect(await store.get(key(row))).toMatchObject({ state: 'delivered', decision: 'approve' });
    await adapter.stop();
  });

  it('fails a stale card closed when the immutable principal binding changes', async () => {
    await store.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:approver-1');
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    await store.recordCardAddress(key(row), 'slack:approver-1', {
      channelType: 'slack',
      platformId: 'D-approver-1',
    });
    await store.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:other-admin');

    expect((await store.recordHumanDecision(row.card_question_id, 'slack:approver-1', 'approve')).status).toBe(
      'unauthorized',
    );
    expect((await store.recordHumanDecision(row.card_question_id, 'slack:other-admin', 'approve')).status).toBe(
      'unauthorized',
    );
    expect((await store.get(key(row)))?.state).toBe('pending');
  });
});

function adapterWith(transport: GatewayApprovalTransport): GatewayApprovalAdapter {
  const cards = cardsWith();
  return new GatewayApprovalAdapter(store, cards, transport);
}

function cardsWith(overrides: Partial<ApprovalCardDependencies> = {}): GatewayApprovalCards {
  const dependencies: ApprovalCardDependencies = {
    resolveBinding: store,
    resolveDm: async () => null,
    deliveryAdapter: () => null,
    decisionReady: vi.fn(),
    ...overrides,
  };
  return new GatewayApprovalCards(store, dependencies);
}

function fakeTransport(overrides: Partial<GatewayApprovalTransport> = {}): GatewayApprovalTransport {
  return {
    snapshot: async () => snapshot(),
    events: async () => 'closed',
    submit: async (command) => acknowledgement(command),
    ...overrides,
  };
}

function acknowledgement(command: DecisionCommand): DecisionSubmission {
  const states: Record<ApprovalDecision, 'approved' | 'rejected' | 'cancelled'> = {
    approve: 'approved',
    reject: 'rejected',
    unavailable: 'cancelled',
  };
  return {
    status: 'acknowledged',
    acknowledgement: {
      version: 'nanoco.approval.v2',
      gatewayEpoch: command.gatewayEpoch,
      approvalId: command.approvalId,
      status: 'applied',
      state: states[command.decision],
    },
  };
}

function snapshot(cursor = 0, approvals: GatewayApproval[] = [makeApproval()]): ApprovalSnapshot {
  return { version: 'nanoco.approval.v2', gatewayEpoch: EPOCH, cursor, approvals };
}

function makeApproval(): GatewayApproval {
  return {
    approvalId: 'ask_0123456789abcdef0123456789abcdef',
    requestDigest: '01'.repeat(32),
    deadline: '2099-07-23T00:00:00.000Z',
    lineage: {
      requestId: 77,
      deploymentId: DEPLOYMENT,
      agentId: 'agent-1',
      sessionId: 'session-1',
      containerInstanceId: 'container-1',
      channelId: 'channel-1',
    },
    approver: { issuer: 'https://idp.example.com', subject: 'stable-idp-subject' },
    policy: { policyVersion: 'policy-v7', matchedPolicyIds: ['ask-production'] },
    summary: {
      method: 'POST',
      origin: 'https://api.example.com:443',
      path: '/v1/action',
    },
    presentation: {
      appId: 'gmail',
      appLabel: 'Gmail',
      operationId: 'gmail:send-email',
      title: 'Send email',
      description: 'Send a new email on the user\'s behalf.',
      class: 'write',
      fields: [
        { label: 'To', kind: 'list', value: ['alice@example.com'] },
        { label: 'Subject', kind: 'text', value: 'Quarterly plan' },
        { label: 'Message', kind: 'long_text', value: 'Ship the small version.' },
      ],
    },
  };
}

function requestedEvent(eventId: number, approval: GatewayApproval): ApprovalEvent {
  return {
    version: 'nanoco.approval.v2',
    eventId,
    gatewayEpoch: EPOCH,
    type: 'approval_requested',
    approval,
  };
}

function terminalEvent(
  eventId: number,
  approval: GatewayApproval,
  state: 'approved' | 'rejected' | 'timed_out' | 'cancelled',
): ApprovalEvent {
  return {
    version: 'nanoco.approval.v2',
    eventId,
    gatewayEpoch: EPOCH,
    type: 'approval_terminal',
    approval,
    state,
  };
}

function dm(): MessagingGroup {
  return {
    id: 'mg-dm-1',
    channel_type: 'slack',
    instance: 'slack-workspace-1',
    platform_id: 'D-approver-1',
    name: 'Approver DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  };
}

function click(questionId: string, channelType: string, userId: string | null, value: string) {
  return { questionId, channelType, userId, value, platformId: '', threadId: null };
}

function key(row: { deployment_id: string; gateway_epoch: string; approval_id: string }) {
  return {
    deploymentId: row.deployment_id,
    gatewayEpoch: row.gateway_epoch,
    approvalId: row.approval_id,
  };
}

async function insertUser(id: string): Promise<void> {
  await db.run(
    'INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
    id,
    'slack',
    id,
    new Date().toISOString(),
  );
}

function graphemes(value: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
}
