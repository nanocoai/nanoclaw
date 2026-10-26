import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayApprovalRequest, GatewaySessionInput } from './gateway-provider-registry.js';

const sdk = vi.hoisted(() => ({
  ensureAgent: vi.fn(async (_input: { name: string; identifier: string }) => ({ created: false })),
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
// Per run, so parallel runs never share one data directory.
const { ADAPTER_DATA } = vi.hoisted(() => ({
  ADAPTER_DATA: `/tmp/nanoclaw-onecli-adapter-${process.pid}-${Date.now()}`,
}));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  DATA_DIR: ADAPTER_DATA,
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

import { contributionFromConfig, grantProviderCredentials, withProviderEnv } from './onecli.js';
import { recordProviderCredentials } from './onecli-provider-credentials.js';
import { log } from '../log.js';
import { getGatewayProviderRegistration } from './gateway-provider-registry.js';

const provider = getGatewayProviderRegistration('onecli')!;
const scope = { ownsAgentGroup: vi.fn(async (id: string) => id === 'g1') };
const subscribe = (decide: Parameters<typeof provider.approvals.subscribe>[0], signal: AbortSignal) =>
  provider.approvals.subscribe(decide, signal, undefined, scope);
const groupInput = (group: string, provider = 'claude'): GatewaySessionInput => ({
  key: { installSlug: 'install', agentGroupId: group, sessionId: `s-${group}` },
  runtimeIdentity: `install/${group}/s-${group}`,
  groupName: group,
  provider,
  containerName: 'fixture-agent',
  capabilities: {} as never,
});
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
  fs.rmSync(ADAPTER_DATA, { recursive: true, force: true });
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

  it('an adopted session (no provider given) reads and writes no grants', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    try {
      await provider.sessions.ensure(input('s1'), controller.signal);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      fetchMock.mockRestore();
    }
  });

  it('a new group gets only the model credential for its provider, before its container config', async () => {
    writeRecord(ADAPTER_DATA, { claude: ['sec-model'], codex: ['sec-codex'] });
    const gateway = fakeGateway();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(gateway.fetch);
    sdk.getContainerConfig.mockImplementationOnce(async () => {
      gateway.calls.push('container-config');
      return {
        env: { HTTPS_PROXY: 'http://host.docker.internal:15001' },
        caCertificate: 'fixture-ca',
        caCertificateContainerPath: '/tmp/onecli-ca.pem',
      };
    });
    const controller = new AbortController();
    try {
      await provider.sessions.ensure(groupInput('g1'), controller.signal);
      expect(gateway.calls).toEqual([
        'GET /v1/agents',
        'GET /v1/agents/oc-g1/grants',
        'GET /v1/secrets',
        'PUT /v1/agents/oc-g1/grants/secrets/sec-model',
        'done /v1/agents/oc-g1/grants/secrets/sec-model',
        'container-config',
      ]);
      expect(gateway.auth).toBe('Bearer unused');
    } finally {
      controller.abort();
      fetchMock.mockRestore();
    }
  });

  let data: string;
  beforeEach(() => {
    data = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-grants-'));
  });
  afterEach(() => fs.rmSync(data, { recursive: true, force: true }));
  const grant = (gateway: ReturnType<typeof fakeGateway>, provider = 'claude') =>
    grantProviderCredentials('g1', provider, { baseUrl: 'http://gw.test', fetchImpl: gateway.fetch, dataDir: data });
  const attached = (gateway: ReturnType<typeof fakeGateway>) =>
    gateway.calls.filter((c) => c.startsWith('PUT ')).map((c) => c.split('/').at(-1));

  it('never attaches tool secrets or app connections: a Vercel or Dial secret stays opt-in', async () => {
    writeRecord(data, { claude: ['sec-model'] });
    const gateway = fakeGateway();
    await expect(grant(gateway)).resolves.toEqual(['sec-model']);
    expect(attached(gateway)).toEqual(['sec-model']);
    expect(gateway.calls.some((c) => c.includes('/connections'))).toBe(false);
  });

  it('a group that switched provider gets the new provider credential and keeps the old grant', async () => {
    writeRecord(data, { claude: ['sec-model'], codex: ['sec-codex'] });
    const gateway = fakeGateway({ held: ['sec-model'] });
    await expect(grant(gateway, 'codex')).resolves.toEqual(['sec-codex']);
    expect(gateway.calls).not.toContain('DELETE /v1/agents/oc-g1/grants/secrets/sec-model');
  });

  it('attaches nothing when the agent already holds its model credential', async () => {
    writeRecord(data, { claude: ['sec-model'] });
    const gateway = fakeGateway({ held: ['sec-model', 'sec-vercel'] });
    await expect(grant(gateway)).resolves.toEqual([]);
    expect(attached(gateway)).toEqual([]);
  });

  it('a login saved after the group existed is attached on the next spawn', async () => {
    const vault = [{ id: 'sec-model', name: 'Anthropic' }];
    const gateway = fakeGateway({ held: ['sec-model'], vault });
    await expect(grant(gateway, 'codex')).resolves.toEqual([]);
    // `/add-codex` saves and records its credential while the group exists.
    vault.push({ id: 'sec-codex', name: 'Codex' });
    writeRecord(data, { claude: ['sec-model'], codex: ['sec-codex'] });
    await expect(grant(gateway, 'codex')).resolves.toEqual(['sec-codex']);
  });

  it('two installs on one gateway: only this install’s recorded credential, never the other’s same-named one', async () => {
    writeRecord(data, { claude: ['sec-model'] });
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-model', name: 'Anthropic' },
        { id: 'sec-other-install', name: 'Anthropic' },
      ],
    });
    await expect(grant(gateway)).resolves.toEqual(['sec-model']);
  });

  it('after the real writer records this install id, the first spawn attaches only that id, not another same-named key', async () => {
    await recordProviderCredentials(data, 'claude', ['sec-own']);
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-own', name: 'Anthropic' },
        { id: 'sec-other-install', name: 'Anthropic' },
      ],
    });
    await expect(grant(gateway)).resolves.toEqual(['sec-own']);
    expect(readRecord(data)).toEqual({ providers: { claude: ['sec-own'] }, matched: ['claude'] });
  });

  it('an unrecorded install with duplicate saved names refuses to guess, attaches nothing, and names the ids', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-a', name: 'Anthropic' },
        { id: 'sec-b', name: 'Anthropic' },
      ],
    });
    await expect(grant(gateway)).rejects.toThrow(/sec-a.*sec-b|sec-b.*sec-a/);
    expect(gateway.calls.some((c) => c.startsWith('PUT'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'onecli', 'provider-credentials.json'))).toBe(false);
  });

  it('an install with no record matches the secrets NanoClaw saved once per provider, then records them', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-model', name: 'Anthropic' },
        { id: 'sec-codex', name: 'Codex' },
        { id: 'sec-oc', name: 'OpenCode openrouter' },
        { id: 'sec-vercel', name: 'Vercel API Token' },
      ],
    });
    await expect(grant(gateway)).resolves.toEqual(['sec-model']);
    await expect(grant(gateway, 'opencode')).resolves.toEqual(['sec-oc']);
    expect(readRecord(data)).toEqual({
      providers: { claude: ['sec-model'], opencode: ['sec-oc'] },
      matched: ['claude', 'opencode'],
    });
  });

  it('matches names only: a typed key under another name may be one user’s, so it is not adopted', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-model', name: 'Anthropic', type: 'anthropic' },
        { id: 'sec-bob', name: 'Anthropic (Bob)', type: 'anthropic' },
        { id: 'sec-chatgpt', name: 'OpenCode ChatGPT', type: 'openai' },
      ],
    });
    await expect(grant(gateway)).resolves.toEqual(['sec-model']);
    await expect(grant(gateway, 'codex')).resolves.toEqual([]);
  });

  it('an older Claude key under another name is not adopted: the host errors with the login that fixes it', async () => {
    // Older setup accepted any type=anthropic secret, so an upgraded install's key may not be named Anthropic.
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-renamed', name: 'Claude key', type: 'anthropic' },
        { id: 'sec-vercel', name: 'Vercel API Token', type: 'generic' },
      ],
    });
    await expect(grant(gateway)).resolves.toEqual([]);
    expect(attached(gateway)).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('pnpm exec tsx setup/index.ts --step gateway-auth claude'),
      expect.objectContaining({ provider: 'claude', unrecorded: ['Claude key'] }),
    );
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('No model credential'), expect.anything());
  });

  it('a converted group that still holds the unrecorded key gets a warning, not an error, and keeps working', async () => {
    const gateway = fakeGateway({
      held: ['sec-renamed'],
      vault: [{ id: 'sec-renamed', name: 'Claude key', type: 'anthropic' }],
    });
    await expect(grant(gateway)).resolves.toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('--step gateway-auth claude'),
      expect.objectContaining({ unrecorded: ['Claude key'] }),
    );
  });

  it('names only Codex-shaped keys for a Codex group, never another provider’s', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-chatgpt', name: 'My ChatGPT', type: 'generic', hostPattern: 'chatgpt.com' },
        { id: 'sec-oc', name: 'OpenCode ChatGPT', type: 'openai' },
      ],
    });
    await expect(grant(gateway, 'codex')).resolves.toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('--step gateway-auth codex'),
      expect.objectContaining({ unrecorded: ['My ChatGPT'] }),
    );
  });

  it('an unrecorded install adopts both Cursor entries once for a Cursor group, and nothing else', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-model', name: 'Anthropic' },
        { id: 'sec-cursor', name: 'Cursor' },
        { id: 'sec-cursor-models', name: 'Cursor models' },
        { id: 'sec-notes', name: 'Cursor notes' },
      ],
    });
    await expect(grant(gateway, 'cursor')).resolves.toEqual(['sec-cursor', 'sec-cursor-models']);
    expect(readRecord(data)).toEqual({
      providers: { cursor: ['sec-cursor', 'sec-cursor-models'] },
      matched: ['cursor'],
    });
  });

  it('a provider with no saved names is never marked matched, so names added in a later release still adopt once', async () => {
    const gateway = fakeGateway({ vault: [{ id: 'sec-model', name: 'Anthropic' }] });
    await expect(grant(gateway, 'ollama')).resolves.toEqual([]);
    await expect(grant(gateway, 'llmman')).resolves.toEqual([]);
    expect(fs.existsSync(path.join(data, 'onecli', 'provider-credentials.json'))).toBe(false);
  });

  it('matches by name only once: after this install’s credential is deleted, another same-named one is not adopted', async () => {
    writeRecord(data, { claude: ['sec-gone'] });
    const gateway = fakeGateway({ vault: [{ id: 'sec-other', name: 'Anthropic' }] });
    await expect(grant(gateway)).resolves.toEqual([]);
    expect(readRecord(data)).toEqual({ providers: { claude: ['sec-gone'] }, matched: ['claude'] });
  });

  it('a login recorded before the first spawn wins over the legacy name match', async () => {
    await recordProviderCredentials(data, 'opencode', ['sec-oc']);
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-oc', name: 'OpenCode openrouter' },
        { id: 'sec-chatgpt', name: 'OpenCode ChatGPT', type: 'openai' },
      ],
    });
    await expect(grant(gateway, 'opencode')).resolves.toEqual(['sec-oc']);
    expect(readRecord(data)).toEqual({ providers: { opencode: ['sec-oc'] }, matched: ['opencode'] });
  });

  it('a held record lock never fails or stalls the spawn: the matched credential is attached and the lock named', async () => {
    fs.mkdirSync(path.join(data, 'onecli'), { recursive: true });
    fs.writeFileSync(path.join(data, 'onecli', 'provider-credentials.json.lock'), 'other-host 1');
    const gateway = fakeGateway({ vault: [{ id: 'sec-model', name: 'Anthropic' }] });
    await expect(grant(gateway)).resolves.toEqual(['sec-model']);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not record'),
      expect.objectContaining({
        provider: 'claude',
        lock: path.join(data, 'onecli', 'provider-credentials.json.lock'),
      }),
    );
    expect(fs.existsSync(path.join(data, 'onecli', 'provider-credentials.json'))).toBe(false);
  });

  it('with the lock held, a match another writer already committed is used as recorded, not widened', async () => {
    fs.mkdirSync(path.join(data, 'onecli'), { recursive: true });
    fs.writeFileSync(path.join(data, 'onecli', 'provider-credentials.json.lock'), 'other-host 1');
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-recorded', name: 'Claude for work' },
        { id: 'sec-legacy', name: 'Anthropic' },
      ],
    });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await gateway.fetch(url, init);
      // The lock holder commits its own recorded id and then dies holding the lock.
      if (new URL(String(url)).pathname === '/v1/secrets') writeRecord(data, { claude: ['sec-recorded'] });
      return res;
    }) as typeof fetch;
    await expect(
      grantProviderCredentials('g1', 'claude', { baseUrl: 'http://gw.test', fetchImpl, dataDir: data }),
    ).resolves.toEqual(['sec-recorded']);
  });

  it('a login that records its id while this spawn reads the vault wins over the legacy match', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-recorded', name: 'Claude for work' },
        { id: 'sec-legacy', name: 'Anthropic' },
      ],
    });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await gateway.fetch(url, init);
      // A setup script records its id (the real writer leaves `matched` unset) mid-spawn.
      if (new URL(String(url)).pathname === '/v1/secrets')
        await recordProviderCredentials(data, 'claude', ['sec-recorded']);
      return res;
    }) as typeof fetch;
    await expect(
      grantProviderCredentials('g1', 'claude', { baseUrl: 'http://gw.test', fetchImpl, dataDir: data }),
    ).resolves.toEqual(['sec-recorded']);
    expect(readRecord(data)).toEqual({ providers: { claude: ['sec-recorded'] }, matched: ['claude'] });
  });

  it('a recorded id that left the vault is not replaced by a name match, even before the match ran', async () => {
    writeRecord(data, { claude: ['sec-gone'] }, []);
    const gateway = fakeGateway({ vault: [{ id: 'sec-other', name: 'Anthropic' }] });
    await expect(grant(gateway)).resolves.toEqual([]);
    expect(readRecord(data)).toEqual({ providers: { claude: ['sec-gone'] }, matched: ['claude'] });
  });

  it.each([
    ['under the lock', false],
    ['with the lock held', true],
  ])('a login recorded after the vault was read keeps its id although that read misses it (%s)', async (_n, held) => {
    if (held) {
      fs.mkdirSync(path.join(data, 'onecli'), { recursive: true });
      fs.writeFileSync(path.join(data, 'onecli', 'provider-credentials.json.lock'), 'other-host 1');
    }
    const gateway = fakeGateway({ vault: [{ id: 'sec-other', name: 'Anthropic' }] });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await gateway.fetch(url, init);
      // This install's login saves and records sec-own after the vault list was taken.
      if (new URL(String(url)).pathname === '/v1/secrets') writeRecord(data, { claude: ['sec-own'] }, []);
      return res;
    }) as typeof fetch;
    await expect(
      grantProviderCredentials('g1', 'claude', { baseUrl: 'http://gw.test', fetchImpl, dataDir: data }),
    ).resolves.toEqual([]);
    expect(gateway.calls.some((c) => c.includes('sec-other'))).toBe(false);
    if (!held) expect(readRecord(data)).toEqual({ providers: { claude: ['sec-own'] }, matched: ['claude'] });
  });

  it('duplicate names do not fail the spawn when a login records one of them meanwhile', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-a', name: 'Anthropic' },
        { id: 'sec-b', name: 'Anthropic' },
      ],
    });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await gateway.fetch(url, init);
      if (new URL(String(url)).pathname === '/v1/secrets') await recordProviderCredentials(data, 'claude', ['sec-a']);
      return res;
    }) as typeof fetch;
    await expect(
      grantProviderCredentials('g1', 'claude', { baseUrl: 'http://gw.test', fetchImpl, dataDir: data }),
    ).resolves.toEqual(['sec-a']);
  });

  it('a match another host finished meanwhile is not repeated (checked again under the lock)', async () => {
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-recorded', name: 'Claude for work' },
        { id: 'sec-legacy', name: 'Anthropic' },
      ],
    });
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await gateway.fetch(url, init);
      // Another host process records its id and finishes the match while this one reads the vault.
      if (new URL(String(url)).pathname === '/v1/secrets') writeRecord(data, { claude: ['sec-recorded'] });
      return res;
    }) as typeof fetch;
    await expect(
      grantProviderCredentials('g1', 'claude', { baseUrl: 'http://gw.test', fetchImpl, dataDir: data }),
    ).resolves.toEqual(['sec-recorded']);
    expect(readRecord(data)).toEqual({ providers: { claude: ['sec-recorded'] }, matched: ['claude'] });
  });

  it('after the one-time match, only recorded ids count (a renamed or new same-named secret adds nothing)', async () => {
    writeRecord(data, { codex: ['sec-codex'] });
    const gateway = fakeGateway({
      vault: [
        { id: 'sec-codex', name: 'renamed by the operator' },
        { id: 'sec-openai', name: 'OpenAI' },
      ],
    });
    await expect(grant(gateway, 'codex')).resolves.toEqual(['sec-codex']);
  });

  it('with no model credential for the provider, warns and lets the spawn go on (keyless endpoints)', async () => {
    const gateway = fakeGateway({ vault: [{ id: 'sec-vercel', name: 'Vercel API Token' }] });
    await expect(grant(gateway, 'opencode')).resolves.toEqual([]);
    expect(attached(gateway)).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No model credential'), {
      agentGroupId: 'g1',
      provider: 'opencode',
    });
  });

  it('refuses to guess when the record file is unreadable', async () => {
    fs.mkdirSync(path.join(data, 'onecli'), { recursive: true });
    fs.writeFileSync(path.join(data, 'onecli', 'provider-credentials.json'), '{"claude": "sec-model"}');
    await expect(grant(fakeGateway())).rejects.toThrow(/must hold provider names/);
  });

  it('attaches nothing and records nothing on a gateway without the grants API, where agents are in all mode', async () => {
    const gateway = fakeGateway({ grantsStatus: 404, grantsBody: UNKNOWN_ROUTE_404 });
    await expect(
      grantProviderCredentials('g1', 'claude', { baseUrl: 'http://gw.test/', fetchImpl: gateway.fetch, dataDir: data }),
    ).resolves.toBeNull();
    expect(gateway.calls).toEqual(['GET /v1/agents', 'GET /v1/agents/oc-g1/grants']);
    expect(fs.existsSync(path.join(data, 'onecli'))).toBe(false);
  });

  it('treats any other grants 404 (agent not found) as a failure, not as a gateway without grants', async () => {
    const gateway = fakeGateway({ grantsStatus: 404, grantsBody: AGENT_NOT_FOUND_404 });
    await expect(grant(gateway)).rejects.toThrow(/returned 404/);
    expect(gateway.calls).not.toContain('GET /v1/secrets');
  });

  it('an interrupted first setup is repaired by the next spawn; nothing is deleted', async () => {
    writeRecord(ADAPTER_DATA, { claude: ['sec-model'] });
    const world = statefulGateway({ vault: ['sec-model', 'sec-vercel'], failPuts: 1 });
    sdk.ensureAgent.mockImplementation(world.ensureAgent);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(world.fetch);
    const first = new AbortController();
    const second = new AbortController();
    try {
      await expect(provider.sessions.ensure(groupInput('g1'), first.signal)).rejects.toThrow(
        /could not grant the claude model credential to agent group g1.*the next spawn retries/,
      );
      expect(world.held('g1')).toEqual([]);
      expect(sdk.getContainerConfig).not.toHaveBeenCalled();
      await provider.sessions.ensure(groupInput('g1'), second.signal);
      expect(world.held('g1')).toEqual(['sec-model']);
      expect(world.deletes).toBe(0);
    } finally {
      first.abort();
      second.abort();
      fetchMock.mockRestore();
      sdk.ensureAgent.mockImplementation(async (_input: { name: string; identifier: string }) => ({ created: false }));
    }
  });

  it('concurrent spawns for one group share one ensureAgent and one grants check, and all wait for it', async () => {
    writeRecord(ADAPTER_DATA, { claude: ['sec-model'] });
    const gateway = fakeGateway({ putDelayMs: 20 });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(gateway.fetch);
    const first = new AbortController();
    const second = new AbortController();
    try {
      await Promise.all([
        provider.sessions.ensure(groupInput('g1'), first.signal).then(() => gateway.calls.push('ready 1')),
        provider.sessions.ensure(groupInput('g1'), second.signal).then(() => gateway.calls.push('ready 2')),
      ]);
      const granted = gateway.calls.indexOf('done /v1/agents/oc-g1/grants/secrets/sec-model');
      expect(granted).toBeGreaterThan(-1);
      expect(gateway.calls.indexOf('ready 1')).toBeGreaterThan(granted);
      expect(gateway.calls.indexOf('ready 2')).toBeGreaterThan(granted);
      expect(sdk.ensureAgent).toHaveBeenCalledTimes(1);
      expect(gateway.calls.filter((c) => c === 'GET /v1/agents/oc-g1/grants')).toHaveLength(1);
    } finally {
      first.abort();
      second.abort();
      fetchMock.mockRestore();
    }
  });

  it('a failed grant fails every concurrent spawn for the group', async () => {
    writeRecord(ADAPTER_DATA, { claude: ['sec-model'] });
    const gateway = fakeGateway({ putStatus: 500, putDelayMs: 20 });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(gateway.fetch);
    const first = new AbortController();
    const second = new AbortController();
    try {
      const results = await Promise.allSettled([
        provider.sessions.ensure(groupInput('g1'), first.signal),
        provider.sessions.ensure(groupInput('g1'), second.signal),
      ]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
      expect(gateway.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
      expect(sdk.getContainerConfig).not.toHaveBeenCalled();
    } finally {
      first.abort();
      second.abort();
      fetchMock.mockRestore();
    }
  });

  describe('ChatGPT login stand-in', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const stubContent = JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: `${encode({ alg: 'HS256' })}.${encode({
          'https://api.openai.com/auth': { chatgpt_account_id: 'onecli-managed' },
        })}.c2ln`,
        access_token: 'onecli-managed',
        refresh_token: 'onecli-managed',
        account_id: 'onecli-managed',
      },
    });
    const withStub = () =>
      sdk.getContainerConfig.mockResolvedValueOnce({
        env: { HTTPS_PROXY: 'http://host.docker.internal:15001' },
        caCertificate: 'fixture-ca',
        caCertificateContainerPath: '/tmp/onecli-ca.pem',
        credentialStubs: [{ containerPath: '/home/node/.codex/auth.json', content: stubContent }],
      } as never);
    const stagedStub = (lease: Awaited<ReturnType<typeof provider.sessions.ensure>>) =>
      JSON.parse(
        fs.readFileSync(
          lease.contribution.mounts!.find((m) => m.containerPath === '/home/node/.codex/auth.json')!.hostPath,
          'utf8',
        ),
      );

    it('stages the stored login workspace id from OneCLI secret metadata', async () => {
      withStub();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json([
          { type: 'anthropic', metadata: { authMode: 'oauth' } },
          { type: 'openai', metadata: { authMode: 'oauth', accountId: 'ws-real-1' } },
        ]),
      );
      const controller = new AbortController();
      try {
        const lease = await provider.sessions.ensure(input('s1'), controller.signal);
        expect(fetchMock).toHaveBeenCalledWith('http://localhost:1/v1/secrets', {
          headers: { Authorization: 'Bearer unused' },
          signal: expect.any(AbortSignal),
        });
        const staged = stagedStub(lease);
        expect(staged.tokens.account_id).toBe('ws-real-1');
        expect(staged.tokens.access_token).toBe('onecli-managed');
      } finally {
        controller.abort();
        fetchMock.mockRestore();
      }
    });

    it('stops the spawn when OneCLI cannot serve the metadata, as for container config', async () => {
      withStub();
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
      try {
        await expect(provider.sessions.ensure(input('s1'), new AbortController().signal)).rejects.toThrow(
          'OneCLI secret metadata unavailable',
        );
      } finally {
        fetchMock.mockRestore();
      }
    });

    it('keeps the placeholder and warns when the metadata is refused or names no single login', async () => {
      for (const response of [
        new Response('', { status: 403 }),
        Response.json([
          { type: 'openai', metadata: { authMode: 'oauth', accountId: 'ws-1' } },
          { type: 'openai', metadata: { authMode: 'oauth', accountId: 'ws-2' } },
        ]),
      ]) {
        withStub();
        vi.mocked(log.warn).mockClear();
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
        const controller = new AbortController();
        try {
          const lease = await provider.sessions.ensure(input('s1'), controller.signal);
          expect(stagedStub(lease).tokens.account_id).toBe('onecli-managed');
          expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('placeholder account id'), expect.anything());
        } finally {
          controller.abort();
          fetchMock.mockRestore();
        }
      }
    });

    it('does not ask OneCLI for metadata when no stand-in needs it', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch');
      const controller = new AbortController();
      try {
        await provider.sessions.ensure(input('s1'), controller.signal);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        controller.abort();
        fetchMock.mockRestore();
      }
    });
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

const UNKNOWN_ROUTE_404 = {
  error: {
    message:
      'Unrecognized request URL (GET: /v1/agents/oc-g1/grants). Please see https://onecli.sh/docs/api-reference for available endpoints.',
    type: 'invalid_request_error',
  },
};
const AGENT_NOT_FOUND_404 = { error: { message: 'Agent not found.', type: 'not_found_error' } };
const DEFAULT_VAULT = [
  { id: 'sec-model', name: 'Anthropic' },
  { id: 'sec-codex', name: 'Codex' },
  { id: 'sec-vercel', name: 'Vercel API Token' },
  { id: 'sec-dial', name: 'Dial' },
];

/** Writes a record; providers listed in `matched` (default: all of them) are past their one-time name match. */
function writeRecord(dataDir: string, providers: Record<string, string[]>, matched = Object.keys(providers)): void {
  fs.mkdirSync(path.join(dataDir, 'onecli'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'onecli', 'provider-credentials.json'), JSON.stringify({ providers, matched }));
}

function readRecord(dataDir: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'onecli', 'provider-credentials.json'), 'utf8'));
}

function fakeGateway(
  opts: {
    grantsStatus?: number;
    grantsBody?: unknown;
    putStatus?: number;
    putDelayMs?: number;
    /** Secret ids the group's agent (oc-g1) already holds. */
    held?: string[];
    vault?: Array<{ id: string; name: string; type?: string; hostPattern?: string }>;
  } = {},
) {
  const calls: string[] = [];
  let auth: string | undefined;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? 'GET';
    auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push(`${method} ${pathname}`);
    if (pathname === '/v1/agents')
      return json([
        { id: 'oc-default', identifier: 'default', isDefault: true },
        { id: 'oc-g1', identifier: 'g1' },
      ]);
    if (pathname === '/v1/agents/oc-g1/grants')
      return json(
        opts.grantsBody ?? {
          mode: 'grants',
          connections: [],
          secrets: (opts.held ?? []).map((secretId) => ({ secretId })),
        },
        opts.grantsStatus,
      );
    if (pathname === '/v1/secrets') return json(opts.vault ?? DEFAULT_VAULT);
    if (method === 'PUT') {
      if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs));
      calls.push(`done ${pathname}`);
      return json({}, opts.putStatus);
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  return {
    calls,
    fetch: fetchImpl,
    get auth() {
      return auth;
    },
  };
}

/** A gateway whose agents and grants change as the adapter creates and attaches. */
function statefulGateway(opts: { vault: string[]; failPuts?: number }) {
  const agents = new Map<string, { id: string; identifier: string; secrets: Set<string> }>();
  let failPuts = opts.failPuts ?? 0;
  let deletes = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const method = init?.method ?? 'GET';
    if (method === 'DELETE') deletes += 1;
    if (pathname === '/v1/agents' && method === 'GET')
      return json([...agents.values()].map((a) => ({ id: a.id, identifier: a.identifier })));
    if (pathname === '/v1/secrets') return json(opts.vault.map((id) => ({ id, name: id })));
    const m = /^\/v1\/agents\/([^/]+)\/grants(?:\/secrets\/([^/]+))?$/.exec(pathname);
    const agent = m ? agents.get(decodeURIComponent(m[1])) : undefined;
    if (!agent) return json({ error: { message: 'Agent not found.', type: 'not_found_error' } }, 404);
    if (!m![2] && method === 'GET')
      return json({ mode: 'grants', connections: [], secrets: [...agent.secrets].map((secretId) => ({ secretId })) });
    if (m![2] && method === 'PUT') {
      if (failPuts > 0) {
        failPuts -= 1;
        return json({ error: 'unavailable' }, 503);
      }
      agent.secrets.add(decodeURIComponent(m![2]));
      return json({});
    }
    return json({ error: 'unexpected' }, 500);
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    ensureAgent: async ({ identifier }: { identifier: string }) => {
      const id = `oc-${identifier}`;
      if (agents.has(id)) return { created: false };
      agents.set(id, { identifier, id, secrets: new Set<string>() });
      return { created: true };
    },
    held: (identifier: string) => [...(agents.get(`oc-${identifier}`)?.secrets ?? [])].sort(),
    get deletes() {
      return deletes;
    },
  };
}
