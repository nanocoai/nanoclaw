import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayApprovalRequest, GatewaySessionInput } from './gateway-provider-registry.js';

const sdk = vi.hoisted(() => ({
  ensureAgent: vi.fn(async () => ({ created: false })),
  applyContainerConfig: vi.fn(async (args: string[]) => {
    args.push('-e', 'HTTPS_PROXY=http://host.docker.internal:15001');
    return true;
  }),
  manualApproval: undefined as undefined | ((request: Record<string, unknown>) => Promise<'approve' | 'deny'>),
  stopApproval: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = sdk.ensureAgent;
    applyContainerConfig = sdk.applyContainerConfig;
    configureManualApproval(callback: (request: Record<string, unknown>) => Promise<'approve' | 'deny'>) {
      sdk.manualApproval = callback;
      return { stop: sdk.stopApproval };
    }
  },
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

import { contributionFromArgs, withProviderEnv } from './onecli.js';
import { getGatewayProviderRegistration } from './gateway-provider-registry.js';

const provider = getGatewayProviderRegistration('onecli')!;
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
});

describe('OneCLI gateway package', () => {
  it('types only the closed env and mount grammar', () => {
    const contribution = contributionFromArgs(
      [
        '-e',
        'HTTPS_PROXY=http://host.docker.internal:15001',
        '-e',
        'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem',
        '-v',
        '/tmp/onecli/ca.pem:/usr/local/share/ca.pem:ro',
        '-v',
        '/tmp/onecli/stub.json:/workspace/.config/creds.json:ro',
      ],
      'g1',
    );

    expect(contribution.env).toEqual({
      HTTPS_PROXY: 'http://host.docker.internal:15001',
      SSL_CERT_FILE: '/tmp/onecli-combined-ca.pem',
    });
    expect(contribution.mounts).toEqual([
      {
        class: 'allowlisted-extra',
        hostPath: '/tmp/onecli/ca.pem',
        containerPath: '/usr/local/share/ca.pem',
        mode: 'ro',
        groupScope: 'g1',
      },
      {
        class: 'allowlisted-extra',
        hostPath: '/tmp/onecli/stub.json',
        containerPath: '/workspace/.config/creds.json',
        mode: 'ro',
        groupScope: 'g1',
      },
    ]);
    expect(() => contributionFromArgs(['--network', 'something'], 'g1')).toThrow(/cannot type/);
    expect(() => contributionFromArgs(['-v', 'h:c:rw:extra'], 'g1')).toThrow(/cannot type/);
  });

  it('owns endpoint configuration and returns a typed session contribution', async () => {
    const controller = new AbortController();
    const lease = await provider.sessions.ensure(input('s1'), controller.signal);

    expect(sdk.ensureAgent).toHaveBeenCalledWith({ name: 'Group One', identifier: 'g1' });
    expect(sdk.applyContainerConfig).toHaveBeenCalledWith(expect.any(Array), {
      addHostMapping: false,
      agent: 'g1',
    });
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
    const subscription = provider.approvals.subscribe(decide, controller.signal);
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
  const subscription = provider.approvals.subscribe(decide, controller.signal);
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
