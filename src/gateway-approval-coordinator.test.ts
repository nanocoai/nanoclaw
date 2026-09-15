import fs from 'node:fs';
import * as approvalDb from './db/sessions.js';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMessagingGroup } from './db/messaging-groups.js';
import { INSTALL_SLUG } from './config.js';
import {
  closeDb,
  createAgentGroup,
  createPendingApproval,
  createSession,
  getPendingApproval,
  initTestDb,
  runMigrations,
} from './db/index.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import {
  gatewayRuntimeIdentity,
  type GatewayApprovalRequest,
  type GatewayProviderDefinition,
} from './gateway-providers/index.js';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-gateway-approval' };
});

vi.mock('./modules/approvals/primitive.js', () => ({
  pickApprover: async () => ['fixture:owner'],
  pickApprovalDelivery: async (users: string[]) => ({
    userId: users[0],
    messagingGroup: {
      id: 'dm-owner',
      channel_type: 'fixture',
      platform_id: 'owner',
      instance: 'fixture-primary',
    },
  }),
}));

vi.mock('./modules/approvals/response-handler.js', async (importOriginal) => importOriginal());

const TEST_DIR = '/tmp/nanoclaw-test-gateway-approval';
const delivered: Array<{ content: string; instance?: string; threadId?: string | null }> = [];
const delivery: ChannelDeliveryAdapter = {
  async deliver(_channelType, _platformId, _threadId, _kind, content, _files, instance) {
    delivered.push({ content, instance, threadId: _threadId });
    return 'platform-message';
  },
};

let decide: Parameters<GatewayProviderDefinition['approvals']['subscribe']>[0];
let failSubscription: ((error: Error) => void) | undefined;

function provider(
  options: { rejectable?: boolean; legacyActions?: readonly string[] } = {},
): GatewayProviderDefinition {
  return {
    kind: 'fixture',
    agentSkills: ['fixture-gateway'],
    sessions: {
      async ensure() {
        return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
      },
    },
    approvals: {
      legacyActions: options.legacyActions,
      async subscribe(callback, signal) {
        decide = callback;
        await new Promise<void>((resolve, reject) => {
          failSubscription = options.rejectable ? reject : undefined;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
  };
}

function request(overrides: Partial<GatewayApprovalRequest> = {}): GatewayApprovalRequest {
  return {
    id: 'native-request',
    agentGroupId: 'ag-1',
    sessionId: 'session-1',
    runtimeIdentity: gatewayRuntimeIdentity({
      installSlug: INSTALL_SLUG,
      agentGroupId: 'ag-1',
      sessionId: 'session-1',
    }),
    createdAt: new Date().toISOString(),
    title: 'Credential request',
    question: 'Allow POST api.example.test/resource?',
    audit: { method: 'POST', host: 'api.example.test' },
    ...overrides,
  };
}

beforeEach(async () => {
  delivered.length = 0;
  failSubscription = undefined;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'Fixture', folder: 'fixture', agent_provider: null, created_at: now });
  await createSession({
    id: 'session-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now,
    created_at: now,
  });
});

afterEach(async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  await coordinator.stopGatewayApprovalCoordinator();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('gateway approval coordinator', () => {
  it('delivers and persists the same shared structured card', async () => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn());
    const pending = decide(
      request({
        summary: {
          agent: 'Nano',
          action: 'Read repository data',
          resource: 'GET api.example.test/repos',
          reason: 'An explicit policy requires approval',
        },
      }),
    );
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const card = JSON.parse(delivered[0].content);
    expect(card.title).toBe('Approve external request');
    expect(card.question).toContain('*Why approval:* An explicit policy requires approval');
    await vi.waitFor(async () => {
      const row = await getPendingApproval(card.questionId);
      expect(row?.question).toBe(card.question);
    });
    await coordinator.stopGatewayApprovalCoordinator();
    expect(await pending).toBe('deny');
  });

  it.each(['first-gateway', 'second-gateway'])('allows configured reads without cards for %s', async (kind) => {
    vi.stubEnv('NANOCLAW_GATEWAY_READ_ONLY_HOSTS', 'api.example.test');
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator({ ...provider(), kind }, delivery, vi.fn());
    for (const method of ['GET', 'HEAD']) {
      expect(await decide(request({ trigger: 'default', destination: { host: 'api.example.test', method } }))).toBe(
        'approve',
      );
    }
    expect(delivered).toHaveLength(0);
  });

  it.each(['policy', 'write', 'missing-method'])(
    'preserves approvals for %s even on a configured host',
    async (scenario) => {
      vi.stubEnv('NANOCLAW_GATEWAY_READ_ONLY_HOSTS', 'api.example.test');
      const coordinator = await import('./gateway-approval-coordinator.js');
      await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn());
      const pending = decide(
        request({
          trigger: scenario === 'policy' ? 'policy' : 'default',
          destination: {
            host: 'api.example.test',
            method: scenario === 'missing-method' ? undefined : scenario === 'write' ? 'POST' : 'GET',
          },
        }),
      );
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      await coordinator.stopGatewayApprovalCoordinator();
      expect(await pending).toBe('deny');
    },
  );

  it.each(['first-gateway', 'second-gateway'])('applies model defaults independently of gateway: %s', async (kind) => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator({ ...provider(), kind }, delivery, vi.fn());
    expect(await decide(request({ trigger: 'default', destination: { host: 'api.anthropic.com' } }))).toBe('approve');
    expect(delivered).toHaveLength(0);
  });

  it.each([
    { trigger: 'policy' as const, destination: { host: 'api.anthropic.com' } },
    { destination: { host: 'api.anthropic.com' } },
    { trigger: 'default' as const, destination: { host: 'api.github.com' } },
    { trigger: 'default' as const, destination: { host: 'api.anthropic.com.evil.test' } },
    { trigger: 'default' as const, destination: { host: 'notanthropic.com' } },
    { trigger: 'default' as const, destination: { host: 'api.anthropic.com:8443' } },
    { trigger: 'default' as const, destination: { host: 'chatgpt.com' } },
  ])('retains human approval for explicit policy or other destinations: %j', async (overrides) => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn());
    const pending = decide(request(overrides));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await coordinator.stopGatewayApprovalCoordinator();
    expect(await pending).toBe('deny');
  });

  it.each([
    { sessionId: 'unknown' },
    { runtimeIdentity: 'wrong' },
    { createdAt: '2000-01-01T00:00:00.000Z' },
    { expiresAt: '2000-01-01T00:00:00.000Z' },
    { destination: { host: 'api.anthropic.com@evil.test' } },
  ])('validates model requests before automatic approval: %j', async (overrides) => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn());
    expect(
      await decide(request({ trigger: 'default', destination: { host: 'api.anthropic.com' }, ...overrides })),
    ).toBe('deny');
    expect(delivered).toHaveLength(0);
  });

  it('uses the session-pinned provider for its model destinations', async () => {
    const { registerProviderHostContract, getProviderHostContract } = await import('./provider-contracts/index.js');
    registerProviderHostContract('fixture-model', {
      ...getProviderHostContract('claude')!,
      modelDomains: ['model.example.test'],
      modelEndpoints: { api: 'https://model.example.test' },
    });
    const coordinator = await import('./gateway-approval-coordinator.js');
    const now = new Date().toISOString();
    await createSession({
      id: 'fixture-session',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'fixture-model',
      status: 'active',
      container_status: 'running',
      last_active: now,
      created_at: now,
    });
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn());
    expect(
      await decide(
        request({
          trigger: 'default',
          destination: { host: 'model.example.test' },
          sessionId: 'fixture-session',
          runtimeIdentity: gatewayRuntimeIdentity({
            installSlug: INSTALL_SLUG,
            agentGroupId: 'ag-1',
            sessionId: 'fixture-session',
          }),
        }),
      ),
    ).toBe('approve');
    expect(delivered).toHaveLength(0);
  });

  it('persists and delivers a normalized request, then accepts only the authorized response', async () => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn(), { timeoutMs: 5_000 });

    const decision = decide(request());
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const card = JSON.parse(delivered[0].content) as { questionId: string };
    await coordinator.handleGatewayApprovalResponse({
      questionId: card.questionId,
      value: 'approve',
      userId: 'fixture:intruder',
      channelType: 'fixture',
      platformId: 'intruder',
      threadId: null,
    });
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await coordinator.handleGatewayApprovalResponse({
      questionId: card.questionId,
      value: 'approve',
      userId: 'fixture:owner',
      channelType: 'fixture',
      platformId: 'owner',
      threadId: null,
    });
    await expect(decision).resolves.toBe('approve');
    expect(delivered[0].instance).toBe('fixture-primary');
  });

  it.each(['approve', 'deny'] as const)(
    'keeps a claimed %s decision when database deletion crosses the deadline',
    async (value) => {
      vi.useFakeTimers();
      const coordinator = await import('./gateway-approval-coordinator.js');
      await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn(), { timeoutMs: 5_000 });
      const decision = decide(request());
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      const { questionId } = JSON.parse(delivered[0].content);
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = approvalDb.deletePendingApproval;
      const deletion = vi.spyOn(approvalDb, 'deletePendingApproval').mockImplementation(async (id) => {
        await blocked;
        return original(id);
      });
      const response = coordinator.handleGatewayApprovalResponse({
        questionId,
        value,
        userId: 'fixture:owner',
        channelType: 'fixture',
        platformId: 'owner',
        threadId: null,
      });
      await vi.waitFor(() => expect(deletion).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await getPendingApproval(questionId))?.status).toBe(value === 'approve' ? 'approved' : 'rejected');
      release();
      await response;
      await expect(decision).resolves.toBe(value);
    },
  );

  it('denies timeout, restart, invalid identity, and pending overload', async () => {
    vi.useFakeTimers();
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn(), {
      timeoutMs: 1_000,
      maxPending: 1,
    });

    const timedOut = decide(request({ id: 'timeout' }));
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(timedOut).resolves.toBe('deny');

    const held = decide(request({ id: 'held' }));
    await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(3));
    await expect(decide(request({ id: 'overload' }))).resolves.toBe('deny');
    await expect(decide(request({ id: 'wrong-session', runtimeIdentity: 'spoofed' }))).resolves.toBe('deny');
    await coordinator.stopGatewayApprovalCoordinator();
    await expect(held).resolves.toBe('deny');
  });

  it('uses the provider expiry instead of shortening its approval window', async () => {
    vi.useFakeTimers();
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn(), { timeoutMs: 1_000 });

    const decision = decide(request({ expiresAt: new Date(Date.now() + 5_000).toISOString() }));
    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(decision).resolves.toBe('deny');
  });

  it('caps a provider expiry so one request cannot occupy the queue indefinitely', async () => {
    vi.useFakeTimers();
    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn(), { timeoutMs: 1_000 });

    const decision = decide(request({ expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const card = JSON.parse(delivered[0].content) as { questionId: string };
    const row = await getPendingApproval(card.questionId);
    expect(Date.parse(row!.expires_at!) - Date.now()).toBeGreaterThan(60 * 60_000 - 500);
    expect(Date.parse(row!.expires_at!) - Date.now()).toBeLessThanOrEqual(60 * 60_000);

    await coordinator.handleGatewayApprovalResponse({
      questionId: card.questionId,
      value: 'reject',
      userId: 'fixture:owner',
      channelType: 'fixture',
      platformId: 'owner',
      threadId: null,
    });
    await expect(decision).resolves.toBe('deny');
  });

  it('denies every hold and reports unavailability when the subscription fails', async () => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    const unavailable = vi.fn();
    await coordinator.startGatewayApprovalCoordinator(provider({ rejectable: true }), delivery, unavailable, {
      timeoutMs: 5_000,
    });
    const held = decide(request({ id: 'bridge-failure' }));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    failSubscription?.(new Error('bridge gone'));
    await expect(held).resolves.toBe('deny');
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith('Gateway approval subscription failed'));
  });

  it('reopens admission when the bridge comes back after a failure', async () => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    const unavailable = vi.fn();
    const available = vi.fn();
    await coordinator.startGatewayApprovalCoordinator(provider({ rejectable: true }), delivery, unavailable, {
      timeoutMs: 5_000,
      onAvailable: available,
    });

    failSubscription?.(new Error('bridge gone'));
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledWith('Gateway approval subscription failed'));

    // The supervisor resubscribes; a retry that stays up past its fail-fast
    // window reopens admission instead of leaving the host closed forever.
    await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    // The reconnected bridge serves requests again.
    const decision = decide(request({ id: 'after-reconnect' }));
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const card = JSON.parse(delivered[0].content) as { questionId: string };
    await coordinator.handleGatewayApprovalResponse({
      questionId: card.questionId,
      value: 'approve',
      userId: 'fixture:owner',
      channelType: 'fixture',
      platformId: 'owner',
      threadId: null,
    });
    await expect(decision).resolves.toBe('approve');
  }, 20_000);

  it('expires stale approval rows before subscribing after a restart', async () => {
    await createPendingApproval({
      approval_id: 'stale-gateway-approval',
      request_id: 'native-stale',
      action: 'gateway_request',
      payload: '{}',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      title: 'Stale request',
      question: 'This must not survive a host restart.',
      options_json: '[]',
      channel_type: 'fixture',
      platform_id: 'owner',
      instance: 'fixture-primary',
      platform_message_id: 'old-platform-message',
    });

    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(provider(), delivery, vi.fn());

    await expect(getPendingApproval('stale-gateway-approval')).resolves.toBeUndefined();
    expect(JSON.parse(delivered[0].content)).toMatchObject({ operation: 'edit', messageId: 'old-platform-message' });
  });

  it('expires approval rows declared by an older provider adapter', async () => {
    await createPendingApproval({
      approval_id: 'legacy-provider-approval',
      request_id: 'native-legacy',
      action: 'fixture_legacy_request',
      payload: '{}',
      created_at: new Date(Date.now() - 60_000).toISOString(),
      title: 'Legacy request',
      question: 'This must not survive adapter migration.',
      options_json: '[]',
      channel_type: 'fixture',
      platform_id: 'owner',
      instance: 'fixture-primary',
      platform_message_id: 'legacy-platform-message',
    });

    const coordinator = await import('./gateway-approval-coordinator.js');
    await coordinator.startGatewayApprovalCoordinator(
      provider({ legacyActions: ['fixture_legacy_request'] }),
      delivery,
      vi.fn(),
    );

    await expect(getPendingApproval('legacy-provider-approval')).resolves.toBeUndefined();
    expect(JSON.parse(delivered[0].content)).toMatchObject({ operation: 'edit', messageId: 'legacy-platform-message' });
  });
});

it('keeps durable decisions until acknowledgement and retries after restart; only selected human can decide', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const gateway = provider();
  const native = request({ approverUserId: 'fixture:selected' });
  const submit = vi.fn().mockResolvedValue(false);
  gateway.approvals.durable = true;
  gateway.approvals.decide = submit;
  gateway.approvals.listPending = async () => [native];
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  const outcome = decide(native);
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  const questionId = JSON.parse(delivered[0].content).questionId;
  const click = {
    questionId,
    value: 'approve',
    userId: 'fixture:owner',
    instance: 'fixture-primary',
    channelType: 'fixture',
    platformId: 'owner',
    threadId: null,
  };
  await coordinator.handleGatewayApprovalResponse(click);
  expect(submit).not.toHaveBeenCalled();
  expect((await getPendingApproval(questionId))?.status).toBe('pending');
  await coordinator.handleGatewayApprovalResponse({ ...click, userId: 'fixture:selected' });
  expect(await outcome).toBe('approve');
  expect(submit).toHaveBeenCalledWith(native.id, 'approve');
  expect((await getPendingApproval(questionId))?.status).toBe('approved');
  await coordinator.stopGatewayApprovalCoordinator();
  submit.mockResolvedValue(true);
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  expect(submit).toHaveBeenCalledTimes(2);
  expect(await getPendingApproval(questionId)).toBeUndefined();
});

it('preserves a durable pending request on host shutdown and closes it on native terminal event', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const gateway = provider();
  const native = request();
  let terminal: ((id: string) => Promise<void>) | undefined;
  const original = gateway.approvals.subscribe;
  gateway.approvals.subscribe = (callback, signal, resolved) => {
    terminal = resolved;
    return original(callback, signal);
  };
  gateway.approvals.durable = true;
  gateway.approvals.decide = vi.fn(async () => true);
  gateway.approvals.listPending = async () => [native];
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  const outcome = decide(native);
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  const questionId = JSON.parse(delivered[0].content).questionId;
  await coordinator.stopGatewayApprovalCoordinator();
  expect(await outcome).toBe('unavailable');
  expect((await getPendingApproval(questionId))?.status).toBe('pending');
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  await terminal!(native.id);
  expect(await getPendingApproval(questionId)).toBeUndefined();
  expect(JSON.parse(delivered.at(-1)!.content).terminalCard.resolution).toContain('ended');
});

it('records durable expiry as unavailable rather than a human rejection', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const gateway = provider();
  const submit = vi.fn(async () => false);
  gateway.approvals.durable = true;
  gateway.approvals.decide = submit;
  gateway.approvals.listPending = async () => [];
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn(), { timeoutMs: 80 });
  const outcome = decide(request());
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  const questionId = JSON.parse(delivered[0].content).questionId;
  expect(await outcome).toBe('unavailable');
  expect(submit).toHaveBeenCalledWith('native-request', 'unavailable');
  expect((await getPendingApproval(questionId))?.status).toBe('expired');
});

it('persists before sending a durable card and does not resend an uncertain delivery after restart', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const gateway = provider();
  const native = request();
  gateway.approvals.durable = true;
  gateway.approvals.decide = vi.fn(async () => true);
  gateway.approvals.listPending = async () => [native];
  let questionId = '';
  const uncertain = {
    ...delivery,
    deliver: async (...args: Parameters<ChannelDeliveryAdapter['deliver']>) => {
      questionId = JSON.parse(args[4]).questionId;
      expect((await getPendingApproval(questionId))?.status).toBe('pending');
      throw new Error('Delivery acknowledgement lost');
    },
  };
  await coordinator.startGatewayApprovalCoordinator(gateway, uncertain, vi.fn());
  expect(await decide(native)).toBe('unavailable');
  expect((await getPendingApproval(questionId))?.platform_message_id).toBeNull();
  await coordinator.stopGatewayApprovalCoordinator();
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  expect(await decide(native)).toBe('unavailable');
  expect(delivered).toHaveLength(0);
  expect(gateway.approvals.decide).toHaveBeenCalledWith(native.id, 'unavailable');
});

it('preserves the approved origin thread on initial delivery', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  await createMessagingGroup({
    id: 'origin',
    channel_type: 'fixture',
    platform_id: 'room',
    instance: 'fixture-primary',
    name: 'Room',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  const gateway = provider();
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  const result = decide(
    request({
      approverUserId: 'fixture:owner',
      approverInstance: 'fixture-primary',
      delivery: { messagingGroupId: 'origin', threadId: 'original-thread' },
    }),
  );
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  expect(delivered[0].threadId).toBe('original-thread');
  await coordinator.stopGatewayApprovalCoordinator();
  await result;
});

it('refuses changed immutable evidence both while held and after a durable decision', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const gateway = provider();
  const native = request({ approverUserId: 'fixture:owner', audit: { digest: 'original' } });
  const submit = vi.fn(async () => false);
  gateway.approvals.durable = true;
  gateway.approvals.decide = submit;
  gateway.approvals.listPending = async () => [native];
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  const result = decide(native);
  expect(await decide({ ...native, audit: { digest: 'changed' } })).toBe('unavailable');
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  const questionId = JSON.parse(delivered[0].content).questionId;
  await coordinator.handleGatewayApprovalResponse({
    questionId,
    value: 'approve',
    userId: 'fixture:owner',
    instance: 'fixture-primary',
    channelType: 'fixture',
    platformId: 'owner',
    threadId: null,
  });
  expect(await result).toBe('approve');
  expect(await decide({ ...native, approverUserId: 'fixture:other' })).toBe('unavailable');
  expect(submit).toHaveBeenCalledTimes(1);
});

it('publishes shared health only after a stable subscription and clears it on failure', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const gateway = provider({ rejectable: true });
  const publish = vi.fn(async (_healthy: boolean) => {});
  gateway.availability = { publish, read: async () => false };
  const resume = vi.fn();
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn(), { onAvailable: resume });
  expect(publish).toHaveBeenCalledWith(false);
  expect(publish).not.toHaveBeenCalledWith(true);
  await vi.waitFor(() => expect(publish).toHaveBeenCalledWith(true), { timeout: 3000 });
  failSubscription!(new Error('stream ended'));
  await vi.waitFor(() => expect(publish.mock.calls.at(-1)).toEqual([false]));
  expect(resume).not.toHaveBeenCalled();
  await coordinator.stopGatewayApprovalCoordinator();
  await vi.waitFor(() => expect(publish.mock.calls.at(-1)).toEqual([false]));
});

it('rejects durable clicks from another adapter instance or card even for the selected user', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const gateway = provider();
  const native = request({ approverUserId: 'fixture:owner' });
  const submit = vi.fn(async () => true);
  gateway.approvals.durable = true;
  gateway.approvals.decide = submit;
  gateway.approvals.listPending = async () => [native];
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  const result = decide(native);
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  const questionId = JSON.parse(delivered[0].content).questionId;
  const click = {
    questionId,
    value: 'approve',
    userId: 'fixture:owner',
    channelType: 'fixture',
    instance: 'fixture-primary',
    platformId: 'owner',
    threadId: null,
    messageId: 'platform-message',
  };
  for (const changed of [
    { instance: 'other-instance' },
    { messageId: 'other-card' },
    { platformId: 'other-room' },
    { instance: undefined },
  ]) {
    await coordinator.handleGatewayApprovalResponse({ ...click, ...changed });
    expect((await getPendingApproval(questionId))?.status).toBe('pending');
    expect(submit).not.toHaveBeenCalled();
  }
  await coordinator.handleGatewayApprovalResponse(click);
  expect(await result).toBe('approve');
  expect(submit).toHaveBeenCalledTimes(1);
});

it('does not manufacture a human rejection when persisting a durable click fails', async () => {
  const coordinator = await import('./gateway-approval-coordinator.js');
  const sessions = await import('./db/sessions.js');
  const gateway = provider();
  const native = request({ approverUserId: 'fixture:owner' });
  const submit = vi.fn(async () => true);
  gateway.approvals.durable = true;
  gateway.approvals.decide = submit;
  gateway.approvals.listPending = async () => [native];
  await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
  const result = decide(native);
  await vi.waitFor(() => expect(delivered).toHaveLength(1));
  const questionId = JSON.parse(delivered[0].content).questionId;
  const transition = vi
    .spyOn(sessions, 'transitionPendingApprovalStatus')
    .mockRejectedValueOnce(new Error('persistence unavailable'));
  try {
    await coordinator.handleGatewayApprovalResponse({
      questionId,
      value: 'approve',
      userId: 'fixture:owner',
      channelType: 'fixture',
      instance: 'fixture-primary',
      platformId: 'owner',
      threadId: null,
      messageId: 'platform-message',
    });
    expect(await result).toBe('unavailable');
    expect(submit).not.toHaveBeenCalled();
    expect((await getPendingApproval(questionId))?.status).toBe('pending');
  } finally {
    transition.mockRestore();
  }
});

it.each([
  ['approve', 'approve', '✅ Approved'],
  ['reject', 'deny', '❌ Rejected'],
] as const)(
  'preserves %s when terminal notification arrives before the decision response',
  async (click, decision, resolution) => {
    const coordinator = await import('./gateway-approval-coordinator.js');
    const gateway = provider();
    const native = request();
    let terminal: ((id: string) => Promise<void>) | undefined;
    const original = gateway.approvals.subscribe;
    gateway.approvals.subscribe = (callback, signal, resolved) => {
      terminal = resolved;
      return original(callback, signal);
    };
    gateway.approvals.durable = true;
    gateway.approvals.listPending = async () => [];
    gateway.approvals.decide = vi.fn(async () => {
      await terminal!(native.id);
      return true;
    });
    await coordinator.startGatewayApprovalCoordinator(gateway, delivery, vi.fn());
    const outcome = decide(native);
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    const questionId = JSON.parse(delivered[0].content).questionId;
    await coordinator.handleGatewayApprovalResponse({
      questionId,
      value: click,
      userId: 'fixture:owner',
      instance: 'fixture-primary',
      channelType: 'fixture',
      platformId: 'owner',
      threadId: null,
    });
    expect(await outcome).toBe(decision);
    expect(JSON.parse(delivered.at(-1)!.content).terminalCard.resolution).toBe(resolution);
    expect(await getPendingApproval(questionId)).toBeUndefined();
  },
);
