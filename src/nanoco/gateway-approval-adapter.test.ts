import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: logMocks.warn,
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { closeDb, initTestDb } from '../db/connection.js';
import type { DbDriver } from '../db/driver.js';
import { runMigrations } from '../db/migrations/index.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import type { MessagingGroup } from '../types.js';
import type { ApprovalEvent, ApprovalSnapshot, DecisionCommand, GatewayApproval } from './approval-contract.js';
import { GatewayApprovalCards } from './approval-cards.js';
import { GatewayApprovalStore } from './approval-store.js';
import {
  ApprovalTransportUnavailable,
  type DecisionSubmission,
  type GatewayApprovalTransport,
} from './approval-transport.js';
import { GatewayApprovalAdapter } from './gateway-approval-adapter.js';

const DEPLOYMENT = 'deployment-1';
const EPOCH = 'gw_0123456789abcdef0123456789abcdef';

let db: DbDriver;
let store: GatewayApprovalStore;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await initTestDb();
  await runMigrations(db);
  await db.run(
    'INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
    'slack:approver-1',
    'slack',
    'Approver',
    new Date().toISOString(),
  );
  store = new GatewayApprovalStore(db, DEPLOYMENT);
  await store.replaceApproverBinding('https://idp.example.com', 'stable-idp-subject', 'slack:approver-1');
});

afterEach(async () => closeDb());

describe('Gateway approval recovery loop', () => {
  it('persists one SSE approval and one card while ignoring the duplicate event', async () => {
    const deliver = vi.fn(async () => 'message-1');
    const event = requestedEvent(1);
    let eventsCalls = 0;
    const transport = transportWith({
      snapshot: async () => snapshot(0, []),
      events: async (_epoch, _cursor, onEvent, signal) => {
        eventsCalls += 1;
        if (eventsCalls === 1) {
          await onEvent(event);
          await onEvent(event);
        }
        await waitForAbort(signal);
        return 'closed';
      },
    });
    const adapter = adapterWith(transport, deliver);
    adapter.start();

    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(
      await store.get({ deploymentId: DEPLOYMENT, gatewayEpoch: EPOCH, approvalId: makeApproval().approvalId }),
    ).toMatchObject({
      state: 'pending',
      event_id: 1,
      card_platform_message_id: 'message-1',
    });
    expect(await store.cursor()).toEqual({ gateway_epoch: EPOCH, cursor: 1 });
    await adapter.stop();
  });

  it('resends a decision that was persisted before restart but never acknowledged', async () => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    await store.recordCardAddress(key(row), 'slack:approver-1', {
      channelType: 'slack',
      platformId: 'D-approver-1',
    });
    await store.markCardAttempted(key(row));
    await store.recordCardDelivered(key(row), 'message-1');
    await store.recordHumanDecision(row.card_question_id, 'slack:approver-1', 'approve');

    const submitted: DecisionCommand[] = [];
    const transport = transportWith({
      submit: async (command) => {
        submitted.push(command);
        return {
          status: 'acknowledged',
          acknowledgement: {
            version: 'nanoco.approval.v2',
            gatewayEpoch: command.gatewayEpoch,
            approvalId: command.approvalId,
            status: 'duplicate',
            state: 'approved',
          },
        };
      },
    });
    const deliver = vi.fn();
    const restarted = adapterWith(transport, deliver);
    restarted.start();

    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.decision).toBe('approve');
    expect(await store.get(key(row))).toMatchObject({ state: 'delivered', gateway_state: 'approved' });
    expect(deliver).not.toHaveBeenCalled();
    await restarted.stop();
  });

  it('reuses a delivered pending card after restart without a second platform delivery', async () => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    await store.recordCardAddress(key(row), 'slack:approver-1', {
      channelType: 'slack',
      platformId: 'D-approver-1',
    });
    await store.markCardAttempted(key(row));
    await store.recordCardDelivered(key(row), null);

    const snapshotRequest = vi.fn(async () => snapshot());
    const transport = transportWith({ snapshot: snapshotRequest });
    const deliver = vi.fn();
    const restarted = adapterWith(transport, deliver);
    restarted.start();

    await vi.waitFor(() => expect(snapshotRequest).toHaveBeenCalledOnce());
    expect(deliver).not.toHaveBeenCalled();
    expect(await store.get(key(row))).toMatchObject({ state: 'pending', card_delivered_at: expect.any(String) });
    await restarted.stop();
  });

  it('reconnects with a fresh snapshot after a normally closed SSE stream', async () => {
    let snapshotCalls = 0;
    let eventCalls = 0;
    const transport = transportWith({
      snapshot: async () => {
        snapshotCalls += 1;
        return snapshot(0, []);
      },
      events: async (_epoch, _cursor, _onEvent, signal) => {
        eventCalls += 1;
        if (eventCalls === 1) return 'closed';
        await waitForAbort(signal);
        return 'closed';
      },
    });
    const adapter = adapterWith(transport, vi.fn());
    adapter.start();

    await vi.waitFor(() => expect(snapshotCalls).toBe(2), { timeout: 2500 });
    expect(eventCalls).toBe(2);
    await adapter.stop();
  });

  it('backs off before snapshot recovery when SSE returns resync_required', async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    const snapshotTimes: number[] = [];
    let eventCalls = 0;
    const transport = transportWith({
      snapshot: async () => {
        snapshotCalls += 1;
        snapshotTimes.push(Date.now());
        return snapshot(0, []);
      },
      events: async (_epoch, _cursor, _onEvent, signal) => {
        eventCalls += 1;
        if (eventCalls === 1) return 'resync_required';
        await waitForAbort(signal);
        return 'closed';
      },
    });
    const adapter = adapterWith(transport, vi.fn());
    try {
      adapter.start();

      await vi.waitFor(() => expect(eventCalls).toBe(1));
      expect(snapshotCalls).toBe(1);
      expect(eventCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(snapshotCalls).toBe(2));
      expect(eventCalls).toBe(2);
      expect(snapshotTimes[1]! - snapshotTimes[0]!).toBeGreaterThanOrEqual(1000);
    } finally {
      await adapter.stop();
      vi.useRealTimers();
    }
  });

  it('logs a fixed transport code without raw TLS or socket text', async () => {
    let attempts = 0;
    const transport = transportWith({
      snapshot: async () => {
        attempts += 1;
        if (attempts === 1) throw new ApprovalTransportUnavailable('request_failed');
        throw new Error('certificate for secret.internal and TLS socket details');
      },
    });
    const adapter = adapterWith(transport, vi.fn());
    adapter.start();

    await vi.waitFor(() => expect(logMocks.warn).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(logMocks.warn).toHaveBeenNthCalledWith(1, 'NanoCo approval connection will retry', {
      code: 'request_failed',
    });
    expect(logMocks.warn).toHaveBeenNthCalledWith(2, 'NanoCo approval connection will retry', {
      code: 'internal',
    });
    expect(JSON.stringify(logMocks.warn.mock.calls)).not.toContain('secret.internal');
    expect(JSON.stringify(logMocks.warn.mock.calls)).not.toContain('certificate');
    await adapter.stop();
  });

  it('keeps a durable decision and survives a mismatched acknowledgement', async () => {
    const row = (await store.reconcileSnapshot(snapshot()))[0]!;
    await store.recordCardAddress(key(row), 'slack:approver-1', {
      channelType: 'slack',
      platformId: 'D-approver-1',
    });
    await store.markCardAttempted(key(row));
    await store.recordCardDelivered(key(row), 'message-1');
    const snapshotRequest = vi.fn(async () => snapshot());
    const submit = vi.fn(async (command: DecisionCommand) => ({
      status: 'acknowledged' as const,
      acknowledgement: {
        version: 'nanoco.approval.v2' as const,
        gatewayEpoch: command.gatewayEpoch,
        approvalId: `ask_${'f'.repeat(32)}`,
        status: 'applied' as const,
        state: 'approved' as const,
      },
    }));
    const transport = transportWith({
      snapshot: snapshotRequest,
      submit,
    });
    const adapter = adapterWith(transport, vi.fn());
    adapter.start();
    await vi.waitFor(() => expect(snapshotRequest).toHaveBeenCalledOnce());

    await expect(
      adapter.handleClick({
        questionId: row.card_question_id,
        value: 'approve',
        userId: 'approver-1',
        channelType: 'slack',
        platformId: 'D-approver-1',
        threadId: null,
      }),
    ).resolves.toBe(true);
    await vi.waitFor(() =>
      expect(logMocks.warn).toHaveBeenCalledWith('NanoCo approval decision state will resync', {
        code: 'internal',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(submit).toHaveBeenCalledOnce();
    expect(await store.get(key(row))).toMatchObject({ state: 'decided', decision: 'approve', acknowledged_at: null });
    await adapter.stop();
  });

  it.each(['retry', 'invalid acknowledgement', 'transport rejection'] as const)(
    'ignores an in-flight old-epoch %s after a new-epoch snapshot',
    async (oldCompletion) => {
      vi.useFakeTimers();
      const old = (await store.reconcileSnapshot(snapshot()))[0]!;
      await store.recordCardAddress(key(old), 'slack:approver-1', {
        channelType: 'slack',
        platformId: 'D-approver-1',
      });
      await store.markCardAttempted(key(old));
      await store.recordCardDelivered(key(old), 'old-message');

      const nextApproval = { ...makeApproval(), approvalId: `ask_${'f'.repeat(32)}` };
      const nextEpoch = 'gw_abcdef0123456789abcdef0123456789';
      let snapshotCalls = 0;
      let eventCalls = 0;
      const eventsReady = deferred<void>();
      const requestResync = deferred<void>();
      const oldSubmission = deferred<DecisionSubmission>();
      let newCardDelivered!: () => void;
      const delivered = new Promise<void>((resolve) => {
        newCardDelivered = resolve;
      });
      const submit = vi.fn(async (command: DecisionCommand): Promise<DecisionSubmission> => {
        if (command.gatewayEpoch === EPOCH) return oldSubmission.promise;
        return {
          status: 'acknowledged' as const,
          acknowledgement: {
            version: 'nanoco.approval.v2' as const,
            gatewayEpoch: command.gatewayEpoch,
            approvalId: command.approvalId,
            status: 'applied' as const,
            state: 'approved' as const,
          },
        };
      });
      const transport = transportWith({
        snapshot: async () => {
          snapshotCalls += 1;
          return snapshotCalls === 1
            ? snapshot()
            : { version: 'nanoco.approval.v2', gatewayEpoch: nextEpoch, cursor: 0, approvals: [nextApproval] };
        },
        events: async (_epoch, _cursor, _onEvent, signal) => {
          eventCalls += 1;
          if (eventCalls === 1) {
            eventsReady.resolve();
            await requestResync.promise;
            return 'resync_required';
          }
          await waitForAbort(signal);
          return 'closed';
        },
        submit,
      });
      const deliver = vi.fn(async () => {
        if ((await store.cursor())?.gateway_epoch === nextEpoch) newCardDelivered();
        return 'new-message';
      });
      const adapter = adapterWith(transport, deliver);

      try {
        adapter.start();
        await eventsReady.promise;
        await adapter.handleClick({
          questionId: old.card_question_id,
          value: 'approve',
          userId: 'approver-1',
          channelType: 'slack',
          platformId: 'D-approver-1',
          threadId: null,
        });
        await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));

        requestResync.resolve();
        await vi.advanceTimersByTimeAsync(1000);
        await delivered;
        expect(submit).toHaveBeenCalledTimes(1);
        expect(submit.mock.calls[0]![0].gatewayEpoch).toBe(EPOCH);

        const next = (await store.get({
          deploymentId: DEPLOYMENT,
          gatewayEpoch: nextEpoch,
          approvalId: nextApproval.approvalId,
        }))!;
        await adapter.handleClick({
          questionId: next.card_question_id,
          value: 'approve',
          userId: 'approver-1',
          channelType: 'slack',
          platformId: 'D-approver-1',
          threadId: null,
        });

        expect(submit).toHaveBeenCalledTimes(1);
        if (oldCompletion === 'retry') {
          oldSubmission.resolve({ status: 'retry' });
        } else if (oldCompletion === 'invalid acknowledgement') {
          oldSubmission.resolve({
            status: 'acknowledged',
            acknowledgement: {
              version: 'nanoco.approval.v2',
              gatewayEpoch: EPOCH,
              approvalId: `ask_${'e'.repeat(32)}`,
              status: 'applied',
              state: 'approved',
            },
          });
        } else {
          oldSubmission.reject(new Error('old transport response contained secret headers'));
        }

        await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
        expect(submit.mock.calls[1]![0].gatewayEpoch).toBe(nextEpoch);
        expect(await store.get(key(next))).toMatchObject({ state: 'delivered', gateway_state: 'approved' });
        expect((await store.get(key(old)))?.state).toBe('expired');
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        requestResync.resolve();
        oldSubmission.resolve({ status: 'retry' });
        await adapter.stop();
        vi.useRealTimers();
      }
    },
  );
});

function adapterWith(transport: GatewayApprovalTransport, deliver: ReturnType<typeof vi.fn>): GatewayApprovalAdapter {
  const cards = new GatewayApprovalCards(store, {
    resolveBinding: store,
    resolveDm: async () => dm(),
    deliveryAdapter: () => ({ deliver: deliver as ChannelDeliveryAdapter['deliver'] }),
    decisionReady: () => adapter.decisionReady(),
  });
  const adapter = new GatewayApprovalAdapter(store, cards, transport);
  return adapter;
}

function transportWith(overrides: Partial<GatewayApprovalTransport> = {}): GatewayApprovalTransport {
  return {
    snapshot: async () => snapshot(),
    events: async (_epoch, _cursor, _onEvent, signal) => {
      await waitForAbort(signal);
      return 'closed';
    },
    submit: async (command) => ({
      status: 'acknowledged',
      acknowledgement: {
        version: 'nanoco.approval.v2',
        gatewayEpoch: command.gatewayEpoch,
        approvalId: command.approvalId,
        status: 'applied',
        state: command.decision === 'approve' ? 'approved' : command.decision === 'reject' ? 'rejected' : 'cancelled',
      },
    }),
    ...overrides,
  };
}

function snapshot(cursor = 0, approvals: GatewayApproval[] = [makeApproval()]): ApprovalSnapshot {
  return { version: 'nanoco.approval.v2', gatewayEpoch: EPOCH, cursor, approvals };
}

function requestedEvent(eventId: number): ApprovalEvent {
  return {
    version: 'nanoco.approval.v2',
    gatewayEpoch: EPOCH,
    eventId,
    type: 'approval_requested',
    approval: makeApproval(),
  };
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
      ],
    },
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

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function key(row: { deployment_id: string; gateway_epoch: string; approval_id: string }) {
  return {
    deploymentId: row.deployment_id,
    gatewayEpoch: row.gateway_epoch,
    approvalId: row.approval_id,
  };
}
