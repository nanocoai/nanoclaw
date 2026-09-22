/**
 * Spec-driven Teams construction and the per-instance tenant pin. The Teams
 * SDK adapter is replaced by a recording double (its constructor needs an
 * app registration; the pin wraps only its `handleWebhook`), the bridge and
 * the webhook server are mocked so the tests observe exactly what the
 * adapter hands them (instance key, routing path, pending route).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import type { ChannelInstanceSpec } from './channel-registry.js';
import type { ChannelCredentialProvider } from './credential-provider.js';

const { handleWebhook } = vi.hoisted(() => ({
  // Echoes the body it received, so a test can prove the pin left the body readable.
  handleWebhook: vi.fn(async (request: Request) => new Response(await request.text(), { status: 202 })),
}));

vi.mock('@chat-adapter/teams', () => ({
  createTeamsAdapter: vi.fn((config: Record<string, unknown>) => ({ name: 'teams', config, handleWebhook })),
}));
vi.mock('./chat-sdk-bridge.js', () => ({
  createChatSdkBridge: vi.fn((config: { adapter: { name: string }; instance?: string }) => ({
    name: config.instance ?? config.adapter.name,
    channelType: config.adapter.name,
    instance: config.instance,
    supportsThreads: true,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  })),
}));
vi.mock('../webhook-server.js', () => ({ registerPendingWebhookRoute: vi.fn() }));

import { createTeamsAdapter } from '@chat-adapter/teams';

import { registerPendingWebhookRoute } from '../webhook-server.js';
import { getChannelInstanceFactory } from './channel-registry.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import {
  TEAMS_DEFAULTS,
  activityTenantId,
  createTeamsAdapterForSpec,
  createTeamsBridge,
  createTeamsBridgeFromSpec,
  pinTeamsAdapterToTenant,
  resolveTeamsCredentials,
  teamsInstanceBridgeFactory,
} from './teams.js';

const OURS = '11111111-1111-1111-1111-111111111111';
const THEIRS = '22222222-2222-2222-2222-222222222222';

const ACME: ChannelInstanceSpec = {
  instance: 'acme',
  channelType: 'teams',
  externalScope: OURS,
  transport: 'webhook',
  webhookPath: '/webhook/teams/acme',
};

function provider(values: Record<string, Record<string, string | undefined>>): ChannelCredentialProvider {
  return {
    async get(instance, key) {
      return values[instance]?.[key];
    },
  };
}

const activity = (fields: Record<string, unknown>) =>
  new Request('http://host/webhook/teams/acme', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture' },
    body: JSON.stringify({ type: 'message', id: 'a1', text: 'hi', from: { id: '29:user' }, ...fields }),
  });

type Pinnable = { handleWebhook: (request: Request) => Promise<Response> };

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('resolveTeamsCredentials', () => {
  it('asks the provider for the four registration keys of the instance', async () => {
    const calls: string[] = [];
    const creds = await resolveTeamsCredentials('acme', {
      async get(instance, key) {
        calls.push(`${instance}:${key}`);
        return { app_id: 'app-1', app_password: 'pw', tenant_id: OURS, app_type: 'SingleTenant' }[key];
      },
    });
    expect(creds).toEqual({ appId: 'app-1', appPassword: 'pw', tenantId: OURS, appType: 'SingleTenant' });
    expect(calls.sort()).toEqual(['acme:app_id', 'acme:app_password', 'acme:app_type', 'acme:tenant_id']);
  });
});

describe('activityTenantId', () => {
  it('reads conversation.tenantId, then channelData.tenant.id, and nothing else', () => {
    expect(activityTenantId({ conversation: { id: 'c', tenantId: OURS } })).toBe(OURS);
    expect(activityTenantId({ channelData: { tenant: { id: OURS } } })).toBe(OURS);
    expect(activityTenantId({ conversation: { tenantId: OURS }, channelData: { tenant: { id: THEIRS } } })).toBe(OURS);
    expect(activityTenantId({ conversation: { tenantId: '' }, channelData: {} })).toBeNull();
    expect(activityTenantId({ conversation: 'nope' })).toBeNull();
    expect(activityTenantId(null)).toBeNull();
  });
});

describe('createTeamsAdapterForSpec', () => {
  it('returns null without an app id', () => {
    expect(createTeamsAdapterForSpec(ACME, { appPassword: 'pw' })).toBeNull();
    expect(createTeamsAdapter).not.toHaveBeenCalled();
  });

  it("passes the registration through; the app's tenant is the provider's tenant_id, else the spec's scope", () => {
    createTeamsAdapterForSpec(ACME, { appId: 'app-1', appPassword: 'pw', appType: 'MultiTenant' });
    expect(vi.mocked(createTeamsAdapter).mock.calls[0][0]).toEqual({
      appId: 'app-1',
      appPassword: 'pw',
      appType: 'MultiTenant',
      appTenantId: OURS,
    });
    createTeamsAdapterForSpec(ACME, { appId: 'app-1', appPassword: 'pw', tenantId: THEIRS });
    expect(vi.mocked(createTeamsAdapter).mock.calls[1][0]).toMatchObject({ appType: undefined, appTenantId: THEIRS });
    createTeamsAdapterForSpec({ ...ACME, externalScope: undefined }, { appId: 'app-1' });
    expect(vi.mocked(createTeamsAdapter).mock.calls[2][0]).toMatchObject({
      appPassword: undefined,
      appTenantId: undefined,
    });
  });
});

describe('tenant pin', () => {
  it('passes an activity from the pinned tenant through with its body intact', async () => {
    const adapter = createTeamsAdapterForSpec(ACME, { appId: 'app-1', appPassword: 'pw' }) as unknown as Pinnable;
    expect(adapter.handleWebhook).not.toBe(handleWebhook); // wrapped
    const res = await adapter.handleWebhook(activity({ conversation: { id: 'c1', tenantId: OURS } }));
    expect(res.status).toBe(202);
    expect(JSON.parse(await res.text())).toMatchObject({ conversation: { tenantId: OURS } });
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });

  it('acks (200) and drops an activity from another tenant, or from none, with one warning each', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const adapter = createTeamsAdapterForSpec(ACME, { appId: 'app-1', appPassword: 'pw' }) as unknown as Pinnable;

    expect((await adapter.handleWebhook(activity({ conversation: { id: 'c1', tenantId: THEIRS } }))).status).toBe(200);
    expect((await adapter.handleWebhook(activity({ channelData: { tenant: { id: THEIRS } } }))).status).toBe(200);
    expect((await adapter.handleWebhook(activity({ conversation: { id: 'c1' } }))).status).toBe(200);
    expect(handleWebhook).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][1]).toEqual({ tenantId: THEIRS, pinnedTenantId: OURS });
    expect(warn.mock.calls[2][1]).toEqual({ tenantId: '(none)', pinnedTenantId: OURS });
  });

  it('reads the tenant off channelData when the conversation carries none', async () => {
    const adapter = createTeamsAdapterForSpec(ACME, { appId: 'app-1', appPassword: 'pw' }) as unknown as Pinnable;
    expect((await adapter.handleWebhook(activity({ channelData: { tenant: { id: OURS } } }))).status).toBe(202);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });

  it("leaves a body that is not JSON to the SDK's own rejection", async () => {
    const adapter = { handleWebhook } as unknown as Parameters<typeof pinTeamsAdapterToTenant>[0];
    pinTeamsAdapterToTenant(adapter, OURS);
    const res = await (adapter as unknown as Pinnable).handleWebhook(
      new Request('http://host/webhook/teams/acme', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(202);
    expect(handleWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('createTeamsBridgeFromSpec (connection-registered instances)', () => {
  it('builds the bridge under the spec instance key and routing path, with the shared defaults', async () => {
    const bridge = await createTeamsBridgeFromSpec(ACME, provider({ acme: { app_id: 'app-1', app_password: 'pw' } }));
    expect(bridge?.instance).toBe('acme');
    const config = vi.mocked(createChatSdkBridge).mock.calls[0][0];
    expect(config).toMatchObject({ instance: 'acme', webhookPath: 'teams/acme', supportsThreads: true });
    expect(config.defaults).toBe(TEAMS_DEFAULTS);
    expect(registerPendingWebhookRoute).not.toHaveBeenCalled();
  });

  it('holds a pending route and returns null while the app id or password is not available', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(await createTeamsBridgeFromSpec(ACME, provider({}))).toBeNull();
    expect(await createTeamsBridgeFromSpec(ACME, provider({ acme: { app_id: 'app-1' } }))).toBeNull();
    expect(registerPendingWebhookRoute).toHaveBeenCalledTimes(2);
    expect(registerPendingWebhookRoute).toHaveBeenCalledWith('teams/acme');
    expect(createChatSdkBridge).not.toHaveBeenCalled();
  });

  it('refuses a transport Teams does not have, without holding a route', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(
      await createTeamsBridgeFromSpec(
        { ...ACME, transport: 'socket' },
        provider({ acme: { app_id: 'a', app_password: 'p' } }),
      ),
    ).toBeNull();
    expect(registerPendingWebhookRoute).not.toHaveBeenCalled();
  });

  it("is what the registry's 'teams' instance factory builds from", async () => {
    const factory = getChannelInstanceFactory('teams');
    expect(factory).toBeTypeOf('function');
    const registration = factory!(ACME);
    expect(registration.defaults).toBe(TEAMS_DEFAULTS);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(await registration.factory()).toBeNull(); // .env of the cwd has no acme registration: pending
    expect(registerPendingWebhookRoute).toHaveBeenCalledWith('teams/acme');
  });
});

describe('createTeamsBridge (env mode) — same construction from .env', () => {
  const originalCwd = process.cwd();

  function withEnv(lines: string[]): void {
    const dir = mkdtempSync(join(tmpdir(), 'teams-env-mode-'));
    writeFileSync(join(dir, '.env'), lines.join('\n') + '\n');
    process.chdir(dir);
  }

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('a named instance reads its suffixed keys, keeps the legacy route, and is not pinned', async () => {
    withEnv([
      'TEAMS_APP_ID_HQ=app-hq',
      'TEAMS_APP_PASSWORD_HQ=pw-hq',
      `TEAMS_APP_TENANT_ID_HQ=${OURS}`,
      'TEAMS_APP_TYPE_HQ=SingleTenant',
    ]);
    const bridge = await teamsInstanceBridgeFactory('hq');
    expect(bridge?.instance).toBe('teams-hq');
    expect(vi.mocked(createTeamsAdapter).mock.calls[0][0]).toEqual({
      appId: 'app-hq',
      appPassword: 'pw-hq',
      appType: 'SingleTenant',
      appTenantId: OURS,
    });
    expect(vi.mocked(createChatSdkBridge).mock.calls[0][0]).toMatchObject({
      instance: 'teams-hq',
      webhookPath: 'teams-hq',
    });
    const adapter = vi.mocked(createChatSdkBridge).mock.calls[0][0].adapter as unknown as Pinnable;
    expect(adapter.handleWebhook).toBe(handleWebhook); // env mode: no tenant pin, as before
  });

  it('the default app reads the bare keys exactly as before, and is null without TEAMS_APP_ID', async () => {
    withEnv(['TEAMS_APP_ID=app-default', 'TEAMS_APP_PASSWORD=pw-default']);
    const bridge = await createTeamsBridge();
    expect(bridge?.instance).toBeUndefined();
    expect(vi.mocked(createTeamsAdapter).mock.calls[0][0]).toEqual({
      appId: 'app-default',
      appPassword: 'pw-default',
      appType: undefined,
      appTenantId: undefined,
    });
    expect(vi.mocked(createChatSdkBridge).mock.calls[0][0]).toMatchObject({
      instance: undefined,
      webhookPath: 'teams',
    });

    withEnv(['TEAMS_APP_PASSWORD=orphan']);
    expect(await createTeamsBridge()).toBeNull();
    expect(registerPendingWebhookRoute).not.toHaveBeenCalled(); // env mode never holds routes
  });
});
