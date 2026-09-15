import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayApprovalRequest, GatewaySessionInput } from './gateway-provider-registry.js';

const sdk = vi.hoisted(() => ({
  ensureAgent: vi.fn(async () => ({ created: false })),
  getContainerConfig: vi.fn(async () => ({
    env: { HTTPS_PROXY: 'http://host.docker.internal:15001' },
    caCertificate: 'fixture-ca',
    caCertificateContainerPath: '/tmp/onecli-ca.pem',
  })),
  startApproval: vi.fn(),
  manualApproval: undefined as undefined | ((request: Record<string, unknown>) => Promise<'approve' | 'deny'>),
  stopApproval: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = sdk.ensureAgent;
    getContainerConfig = sdk.getContainerConfig;
  },
  ApprovalClient: class {
    resolve?: () => void;
    start(callback: (request: Record<string, unknown>) => Promise<'approve' | 'deny'>) {
      sdk.manualApproval = callback;
      const running = sdk.startApproval(callback);
      if (running) return running;
      return new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
    stop() {
      sdk.stopApproval();
      this.resolve?.();
    }
  },
}));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-onecli-adapter-review',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    ONECLI_URL: 'http://localhost:1',
    ONECLI_API_KEY: 'unused',
    ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
  }),
}));

import { contributionFromConfig, withProviderEnv } from './onecli.js';
import { getGatewayProviderRegistration } from './gateway-provider-registry.js';

const provider = getGatewayProviderRegistration('onecli')!;
const scope = { ownsAgentGroup: vi.fn(async (id: string) => id === 'g1') };
const subscribe = (decide: Parameters<typeof provider.approvals.subscribe>[0], signal: AbortSignal) =>
  provider.approvals.subscribe(decide, signal, undefined, scope);
const input = (sessionId: string): GatewaySessionInput => ({
  key: { installSlug: 'install', agentGroupId: 'g1', sessionId },
  runtimeIdentity: `install/g1/${sessionId}`,
  groupName: 'Group One',
  containerName: 'fixture-agent',
  capabilities: {} as never,
});

beforeEach(() => {
  vi.clearAllMocks();
  sdk.manualApproval = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync('/tmp/nanoclaw-onecli-adapter-review', { recursive: true, force: true });
});

describe('OneCLI gateway package', () => {
  it.each(['copy-a', 'copy-b'])('leaves foreign requests untouched by the real SDK poller: %s', async (owned) => {
    const { ApprovalClient } = await vi.importActual<typeof import('@onecli-sh/sdk')>('@onecli-sh/sdk');
    const controller = new AbortController();
    let client: InstanceType<typeof ApprovalClient>;
    let callbacksSettled = 0;
    sdk.startApproval.mockImplementationOnce((callback) => {
      client = new ApprovalClient('http://fixture.test', '', 'http://fixture.test', null);
      return client.start(async (request) => {
        try {
          return await callback(request);
        } finally {
          callbacksSettled++;
        }
      });
    });
    sdk.stopApproval.mockImplementationOnce(() => client.stop());
    const requests = ['copy-a', 'copy-b'].flatMap((group) =>
      [false, true].map((stale) => ({
        id: `${group}-${stale ? 'stale' : 'fresh'}`,
        createdAt: new Date(stale ? 0 : Date.now() + 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource',
        agent: { name: group, externalId: group },
      })),
    );
    let polled = false;
    const decisions: Array<{ id: string; decision: string }> = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const endpoint = new URL(String(url));
      if (endpoint.pathname.endsWith('/decision')) {
        decisions.push({ id: endpoint.pathname.split('/')[3], ...JSON.parse(String(options?.body)) });
        return new Response('{}');
      }
      if (!polled) {
        polled = true;
        return Response.json({ requests, timeoutSeconds: 30 });
      }
      return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
      });
    });
    const decide = vi.fn(async () => 'approve' as const);
    const running = provider.approvals.subscribe(decide, controller.signal, undefined, {
      ownsAgentGroup: async (id: string) => id === owned,
    });
    try {
      await vi.waitFor(() => expect(decisions.length).toBeGreaterThanOrEqual(2));
      await vi.waitFor(() => expect(callbacksSettled).toBe(requests.length));
      expect(decisions.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: `${owned}-fresh`, decision: 'approve' },
        { id: `${owned}-stale`, decision: 'deny' },
      ]);
      expect(decide).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await running;
      fetchMock.mockRestore();
    }
  });

  it('submits no decision if installation ownership cannot be read', async () => {
    const controller = new AbortController();
    const decide = vi.fn(async () => 'approve' as const);
    const running = provider.approvals.subscribe(decide, controller.signal, undefined, {
      ownsAgentGroup: async () => {
        throw new Error('ownership unavailable');
      },
    });
    try {
      await vi.waitFor(() => expect(sdk.manualApproval).toBeTypeOf('function'));
      await expect(
        sdk.manualApproval!({
          id: 'foreign',
          createdAt: new Date(0).toISOString(),
          agent: { name: 'other', externalId: 'other' },
        }),
      ).rejects.toThrow('ownership unavailable');
      expect(decide).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await running;
    }
  });

  it('keeps same-basename stubs separate across destinations and agents on the real filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-stubs-'));
    try {
      const config = {
        env: {},
        caCertificate: 'CA',
        caCertificateContainerPath: '/tmp/ca.pem',
        credentialStubs: [
          { containerPath: '/first/config.json', content: 'first-stub' },
          { containerPath: '/second/config.json', content: 'second-stub' },
        ],
      };
      const first = contributionFromConfig(config, 'g1', root);
      const second = contributionFromConfig(
        { ...config, credentialStubs: [{ containerPath: '/first/config.json', content: 'other-agent' }] },
        'g2',
        root,
      );
      const a = first.mounts!.find((m) => m.containerPath === '/first/config.json')!;
      const b = first.mounts!.find((m) => m.containerPath === '/second/config.json')!;
      expect(a.hostPath).not.toBe(b.hostPath);
      expect(fs.readFileSync(a.hostPath, 'utf8')).toBe('first-stub');
      expect(fs.readFileSync(b.hostPath, 'utf8')).toBe('second-stub');
      expect(second.mounts!.find((m) => m.containerPath === '/first/config.json')!.hostPath).not.toBe(a.hostPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('propagates approval startup failure so core can reconnect', async () => {
    sdk.startApproval.mockImplementationOnce(() => {
      throw new Error('gateway URL unavailable');
    });
    await expect(subscribe(async () => 'deny', new AbortController().signal)).rejects.toThrow(
      'gateway URL unavailable',
    );
    expect(sdk.stopApproval).toHaveBeenCalled();
  });

  it('exposes the pinned SDK gateway discovery rejection through the provider subscription', async () => {
    const { ApprovalClient } = await vi.importActual<typeof import('@onecli-sh/sdk')>('@onecli-sh/sdk');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    sdk.startApproval.mockImplementationOnce((callback) =>
      new ApprovalClient('http://localhost:1', 'fixture', null, null).start(callback),
    );
    try {
      await expect(subscribe(async () => 'deny', new AbortController().signal)).rejects.toThrow(
        'Failed to resolve gateway URL',
      );
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:1/v1/gateway-url', expect.anything());
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('owns endpoint configuration and returns a typed session contribution', async () => {
    const controller = new AbortController();
    const lease = await provider.sessions.ensure(input('s1'), controller.signal);

    expect(sdk.ensureAgent).toHaveBeenCalledWith({ name: 'Group One', identifier: 'g1' });
    expect(sdk.getContainerConfig).toHaveBeenCalledWith({ agent: 'g1' });
    expect(lease.contribution).toMatchObject({
      env: {
        HTTPS_PROXY: 'http://host.docker.internal:15001',
        ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
        ANTHROPIC_AUTH_TOKEN: 'gateway-managed',
      },
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: 'onecli' },
      },
    });
    expect(withProviderEnv({}, '')).toEqual({});
    controller.abort();
  });

  it('shares one health monitor across live leases and reports failure to each session', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = await provider.sessions.ensure(input('s1'), firstController.signal);
    const second = await provider.sessions.ensure(input('s2'), secondController.signal);
    const unavailable = vi.fn();
    first.onUnavailable?.(unavailable);
    second.onUnavailable?.(unavailable);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    firstController.abort();
    secondController.abort();
    fetchMock.mockRestore();
  });

  it('translates native approvals once and stops the subscription on cancellation', async () => {
    const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'approve' as const);
    const controller = new AbortController();
    const subscription = subscribe(decide, controller.signal);
    await vi.waitFor(() => expect(sdk.manualApproval).toBeTypeOf('function'));
    const createdAt = new Date(Date.now() + 1_000).toISOString();

    await expect(
      sdk.manualApproval!({
        id: 'native-1',
        createdAt,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        method: 'POST',
        host: 'api.example.test',
        path: '/resource',
        bodyPreview: '{"safe":"preview","mention":"<@U123>"}',
        agent: { name: 'Group <@U123>', externalId: 'g1' },
      }),
    ).resolves.toBe('approve');
    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'native-1',
        trigger: 'policy',
        destination: { host: 'api.example.test', method: 'POST' },
        agentGroupId: 'g1',
        createdAt,
        title: 'Credentials Request',
        audit: { method: 'POST', host: 'api.example.test', path: '/resource' },
      }),
    );
    expect(decide.mock.calls[0][0].question).not.toContain('<@U123>');

    await expect(
      sdk.manualApproval!({
        id: 'stale',
        createdAt: new Date(0).toISOString(),
        method: 'GET',
        host: 'api.example.test',
        path: '/',
        agent: { name: 'Group One', externalId: 'g1' },
      }),
    ).resolves.toBe('deny');
    expect(decide).toHaveBeenCalledTimes(1);

    controller.abort();
    await subscription;
    expect(sdk.stopApproval).toHaveBeenCalledOnce();
  });
});

const compatibilityFixtures = JSON.parse(fs.readFileSync('gateway-compat/onecli-summary/fixtures.json', 'utf8')) as {
  name: string;
  request: { host: string; method: string; path: string };
  summary: { action: string; details: { label: string; value: string }[] };
}[];

it.each(compatibilityFixtures)('preserves native OneCLI approval content: $name', async (fixture) => {
  const decide = vi.fn(async (_request: GatewayApprovalRequest) => 'deny' as const);
  const controller = new AbortController();
  const subscription = subscribe(decide, controller.signal);
  await vi.waitFor(() => expect(sdk.manualApproval).toBeTypeOf('function'));
  await sdk.manualApproval!({
    id: 'native-fixture',
    createdAt: new Date(Date.now() + 1000).toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    ...fixture.request,
    summary: fixture.summary,
    agent: { name: 'Nano', externalId: 'g1' },
  });
  expect(decide.mock.calls[0][0].summary).toEqual({
    agent: 'Nano',
    action: fixture.summary.action,
    details: fixture.summary.details,
    resource: `${fixture.request.method} ${fixture.request.host}${fixture.request.path}`,
    reason: 'The gateway policy requires human approval for this request.',
  });
  controller.abort();
  await subscription;
});
