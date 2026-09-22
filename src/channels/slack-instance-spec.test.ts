/**
 * Spec-driven Slack construction and the per-instance workspace pin, driven
 * against the REAL @chat-adapter/slack (4.29.0) with fake HTTP — signed
 * webhook requests and Socket Mode envelopes — and no network. The bridge
 * and the webhook server are mocked so the tests observe exactly what the
 * adapter hands them (instance key, routing path, pending route).
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SlackAdapter } from '@chat-adapter/slack';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import type { ChannelInstanceSpec } from './channel-registry.js';
import type { ChannelCredentialProvider } from './credential-provider.js';

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

import { registerPendingWebhookRoute } from '../webhook-server.js';
import { getChannelInstanceFactory } from './channel-registry.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import {
  SLACK_DEFAULTS,
  createSlackAdapterForSpec,
  createSlackBridge,
  createSlackBridgeFromSpec,
  envelopeTeamId,
  pinSlackAdapterToWorkspace,
  resolveSlackCredentials,
  slackInstanceBridgeFactory,
  webhookEnvelopeTeamId,
} from './slack.js';

/** The adapter's Socket Mode router, as the pin sees it. */
type SocketRouterFn = (body: Record<string, unknown>, eventType: string, ack: () => Promise<void>) => Promise<void>;

const OURS = 'T0CUSTOMER1';
const THEIRS = 'T0SOMEONEELSE';
const SECRET = 'slack-signing-secret-fixture';

const ACME: ChannelInstanceSpec = {
  instance: 'acme-hq',
  channelType: 'slack',
  externalScope: OURS,
  transport: 'webhook',
  webhookPath: '/webhook/slack/acme-hq',
};

function provider(values: Record<string, Record<string, string | undefined>>): ChannelCredentialProvider {
  return {
    async get(instance, key) {
      return values[instance]?.[key];
    },
  };
}

/** A request signed the way Slack signs webhooks (v0 HMAC over `v0:<ts>:<body>`). */
function signed(body: string, contentType = 'application/json', secret = SECRET): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return new Request('http://host/webhook/slack/acme-hq', {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-slack-request-timestamp': ts, 'x-slack-signature': signature },
    body,
  });
}

function unsigned(body: string): Request {
  return new Request('http://host/webhook/slack/acme-hq', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

const eventCallback = (teamId: string | null) =>
  JSON.stringify({
    type: 'event_callback',
    ...(teamId === null ? {} : { team_id: teamId }),
    event: { type: 'message', channel: 'D0FIXTURE', user: 'U0FIXTURE', text: 'hi', ts: '1.0' },
    event_id: 'Ev0FIXTURE',
    event_time: 1,
  });

/** Replace the adapter's internal dispatchers so nothing needs a live Chat instance. */
function spyDispatchers(adapter: SlackAdapter) {
  const target = adapter as unknown as Record<string, unknown>;
  const processEventPayload = vi.fn();
  const handleSlashCommand = vi.fn(async () => new Response('slash', { status: 200 }));
  const handleInteractivePayload = vi.fn(async () => new Response('interactive', { status: 200 }));
  const dispatchInteractivePayload = vi.fn(async () => new Response(null, { status: 200 }));
  Object.assign(target, {
    processEventPayload,
    handleSlashCommand,
    handleInteractivePayload,
    dispatchInteractivePayload,
  });
  return { processEventPayload, handleSlashCommand, handleInteractivePayload, dispatchInteractivePayload };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('resolveSlackCredentials', () => {
  it('asks the provider for the three token keys of the instance', async () => {
    const calls: string[] = [];
    const creds = await resolveSlackCredentials('acme-hq', {
      async get(instance, key) {
        calls.push(`${instance}:${key}`);
        return key === 'bot_token' ? 'xoxb-1' : key === 'signing_secret' ? 'sig' : undefined;
      },
    });
    expect(creds).toEqual({ botToken: 'xoxb-1', signingSecret: 'sig', appToken: undefined });
    expect(calls.sort()).toEqual(['acme-hq:app_token', 'acme-hq:bot_token', 'acme-hq:signing_secret']);
  });
});

describe('createSlackAdapterForSpec', () => {
  it('returns null without a bot token', () => {
    expect(createSlackAdapterForSpec(ACME, { signingSecret: SECRET })).toBeNull();
  });

  it('builds webhook mode for a webhook spec, socket mode for a socket spec, and refuses socket without an app token', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const webhook = createSlackAdapterForSpec(ACME, { botToken: 'xoxb-1', signingSecret: SECRET });
    expect((webhook as unknown as { mode: string }).mode).toBe('webhook');

    const socket = createSlackAdapterForSpec(
      { ...ACME, transport: 'socket' },
      { botToken: 'xoxb-1', appToken: 'xapp-1' },
    );
    expect((socket as unknown as { mode: string }).mode).toBe('socket');

    expect(createSlackAdapterForSpec({ ...ACME, transport: 'socket' }, { botToken: 'xoxb-1' })).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Socket Mode'), { instance: 'acme-hq' });
  });
});

describe('workspace pin — webhook transport (real adapter, signed fake HTTP)', () => {
  function pinnedWebhookAdapter(): SlackAdapter {
    const adapter = createSlackAdapterForSpec(ACME, { botToken: 'xoxb-1', signingSecret: SECRET });
    if (!adapter) throw new Error('adapter did not build');
    return adapter;
  }

  it('processes a signed event from the pinned workspace', async () => {
    const adapter = pinnedWebhookAdapter();
    const spies = spyDispatchers(adapter);
    const res = await adapter.handleWebhook(signed(eventCallback(OURS)));
    expect(res.status).toBe(200);
    expect(spies.processEventPayload).toHaveBeenCalledTimes(1);
    expect(spies.processEventPayload.mock.calls[0][0]).toMatchObject({ type: 'event_callback', team_id: OURS });
  });

  it('acks (200) and drops a signed event from another workspace, and one that names none, with one warning each', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const adapter = pinnedWebhookAdapter();
    const spies = spyDispatchers(adapter);

    const theirs = await adapter.handleWebhook(signed(eventCallback(THEIRS)));
    expect(theirs.status).toBe(200);
    const none = await adapter.handleWebhook(signed(eventCallback(null)));
    expect(none.status).toBe(200);

    expect(spies.processEventPayload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][1]).toEqual({
      transport: 'webhook',
      eventType: undefined,
      teamId: THEIRS,
      workspaceId: OURS,
    });
    expect(warn.mock.calls[1][1]).toMatchObject({ teamId: '(none)' });
  });

  it('lets url_verification through to the adapter, which answers only when the signature is valid', async () => {
    const adapter = pinnedWebhookAdapter();
    const spies = spyDispatchers(adapter);
    const body = JSON.stringify({ type: 'url_verification', token: 'x', challenge: 'chal-123' });

    const ok = await adapter.handleWebhook(signed(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ challenge: 'chal-123' });

    // Once credentials exist, signatures are enforced: the pending-route
    // no-signature echo is a core behaviour that ends at the live start.
    const bad = await adapter.handleWebhook(unsigned(body));
    expect(bad.status).toBe(401);
    expect(spies.processEventPayload).not.toHaveBeenCalled();
  });

  it('pins slash commands and interactive payloads (form-encoded) too', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const adapter = pinnedWebhookAdapter();
    const spies = spyDispatchers(adapter);
    const form = 'application/x-www-form-urlencoded';

    expect((await adapter.handleWebhook(signed(`command=%2Fnanoco&text=hi&team_id=${THEIRS}`, form))).status).toBe(200);
    expect(spies.handleSlashCommand).not.toHaveBeenCalled();
    expect(await (await adapter.handleWebhook(signed(`command=%2Fnanoco&text=hi&team_id=${OURS}`, form))).text()).toBe(
      'slash',
    );
    expect(spies.handleSlashCommand).toHaveBeenCalledTimes(1);

    const interactive = (teamId: string) =>
      `payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', team: { id: teamId }, actions: [] }))}`;
    expect((await adapter.handleWebhook(signed(interactive(THEIRS), form))).status).toBe(200);
    expect(spies.handleInteractivePayload).not.toHaveBeenCalled();
    expect(await (await adapter.handleWebhook(signed(interactive(OURS), form))).text()).toBe('interactive');
    expect(spies.handleInteractivePayload).toHaveBeenCalledTimes(1);
  });

  it("hands the adapter the untouched body: a mismatched signature is still the adapter's 401", async () => {
    const adapter = pinnedWebhookAdapter();
    spyDispatchers(adapter);
    const res = await adapter.handleWebhook(signed(eventCallback(OURS), 'application/json', 'wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('webhookEnvelopeTeamId reads every envelope shape and never consumes the request body', async () => {
    const req = signed(eventCallback(OURS));
    expect(await webhookEnvelopeTeamId(req)).toEqual({ teamId: OURS });
    expect(await req.text()).toBe(eventCallback(OURS));
    expect(await webhookEnvelopeTeamId(signed(JSON.stringify({ type: 'url_verification', challenge: 'c' })))).toBe(
      'verification',
    );
    expect(await webhookEnvelopeTeamId(signed('not json'))).toBe('unparseable');
    expect(
      await webhookEnvelopeTeamId(signed('command=%2Fx&team_id=T0FORM', 'application/x-www-form-urlencoded')),
    ).toEqual({ teamId: 'T0FORM' });
    expect(
      await webhookEnvelopeTeamId(
        signed(`payload=${encodeURIComponent('{"team":{"id":"T0PAYLOAD"}}')}`, 'application/x-www-form-urlencoded'),
      ),
    ).toEqual({ teamId: 'T0PAYLOAD' });
  });
});

describe('workspace pin — Socket Mode (real adapter router, fake ack)', () => {
  function pinnedSocketAdapter(): SlackAdapter {
    const adapter = createSlackAdapterForSpec(
      { ...ACME, transport: 'socket' },
      { botToken: 'xoxb-1', appToken: 'xapp-1' },
    );
    if (!adapter) throw new Error('adapter did not build');
    return adapter;
  }

  it('routes an envelope from the pinned workspace to the adapter, acks and drops the others', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const adapter = pinnedSocketAdapter();
    const spies = spyDispatchers(adapter);
    const route = (adapter as unknown as { routeSocketEvent: SocketRouterFn }).routeSocketEvent;
    const ack = vi.fn(async () => {});

    await route(
      { team_id: OURS, event: { type: 'message', text: 'hi' }, event_id: 'Ev1', event_time: 1 },
      'events_api',
      ack,
    );
    expect(spies.processEventPayload).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledTimes(1); // the SDK's own ack for events_api

    await route({ team_id: THEIRS, event: { type: 'message' } }, 'events_api', ack);
    await route({ type: 'block_actions', team: { id: THEIRS }, actions: [] }, 'interactive', ack);
    await route({ command: '/nanoco', team_id: THEIRS }, 'slash_commands', ack);
    expect(spies.processEventPayload).toHaveBeenCalledTimes(1);
    expect(spies.dispatchInteractivePayload).not.toHaveBeenCalled();
    expect(spies.handleSlashCommand).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][1]).toEqual({
      transport: 'socket',
      eventType: 'events_api',
      teamId: THEIRS,
      workspaceId: OURS,
    });
  });

  it('refuses an adapter without a Socket Mode router rather than run unpinned, and the real one still has it', () => {
    const fake = { handleWebhook: async () => new Response('') } as unknown as SlackAdapter;
    expect(() => pinSlackAdapterToWorkspace(fake, OURS)).toThrow(/routeSocketEvent/);
    const proto = SlackAdapter.prototype as unknown as { routeSocketEvent?: unknown; handleWebhook?: unknown };
    expect(typeof proto.routeSocketEvent).toBe('function');
    expect(typeof proto.handleWebhook).toBe('function');
  });

  it('envelopeTeamId reads events_api, interactive and authorizations envelopes, and nothing else', () => {
    expect(envelopeTeamId({ team_id: OURS })).toBe(OURS);
    expect(envelopeTeamId({ type: 'view_submission', team: { id: OURS } })).toBe(OURS);
    expect(envelopeTeamId({ event: {}, authorizations: [{ team_id: OURS, user_id: 'U1' }] })).toBe(OURS);
    expect(envelopeTeamId({ team_id: OURS, team: { id: THEIRS } })).toBe(OURS);
    expect(envelopeTeamId({ team_id: '' })).toBeNull();
    expect(envelopeTeamId({ team: 'not an object' })).toBeNull();
    expect(envelopeTeamId({ authorizations: [] })).toBeNull();
    expect(envelopeTeamId(null)).toBeNull();
    expect(envelopeTeamId(OURS)).toBeNull();
  });
});

describe('createSlackBridgeFromSpec (connection-registered instances)', () => {
  it('builds the bridge under the spec instance key and routing path, with the shared defaults', async () => {
    const bridge = await createSlackBridgeFromSpec(
      ACME,
      provider({ 'acme-hq': { bot_token: 'xoxb-1', signing_secret: SECRET } }),
    );
    expect(bridge).not.toBeNull();
    expect(createChatSdkBridge).toHaveBeenCalledTimes(1);
    const config = vi.mocked(createChatSdkBridge).mock.calls[0][0];
    expect(config).toMatchObject({ instance: 'acme-hq', webhookPath: 'slack/acme-hq', supportsThreads: true });
    expect(config.defaults).toBe(SLACK_DEFAULTS);
    expect((config.adapter as unknown as { mode: string }).mode).toBe('webhook');
    // The channels-branch ChannelAdapter type predates resolveConversation; the
    // extension rides on the returned object (see assembleSlackBridge).
    expect((bridge as unknown as { resolveConversation?: unknown }).resolveConversation).toBeTypeOf('function');
    expect(registerPendingWebhookRoute).not.toHaveBeenCalled();
  });

  it('holds a pending route and returns null while the bot token or signing secret is not available', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(await createSlackBridgeFromSpec(ACME, provider({}))).toBeNull();
    expect(await createSlackBridgeFromSpec(ACME, provider({ 'acme-hq': { bot_token: 'xoxb-1' } }))).toBeNull();
    expect(registerPendingWebhookRoute).toHaveBeenCalledTimes(2);
    expect(registerPendingWebhookRoute).toHaveBeenCalledWith('slack/acme-hq');
    expect(createChatSdkBridge).not.toHaveBeenCalled();
  });

  it('a default-instance spec keeps the platform route and an undefined bridge instance', async () => {
    await createSlackBridgeFromSpec(
      { instance: 'slack', channelType: 'slack', transport: 'webhook' },
      provider({ slack: { bot_token: 'xoxb-1', signing_secret: SECRET } }),
    );
    expect(vi.mocked(createChatSdkBridge).mock.calls[0][0]).toMatchObject({
      instance: undefined,
      webhookPath: 'slack',
    });
  });

  it("is what the registry's 'slack' instance factory builds from", async () => {
    const factory = getChannelInstanceFactory('slack');
    expect(factory).toBeTypeOf('function');
    const registration = factory!(ACME);
    expect(registration.defaults).toBe(SLACK_DEFAULTS);
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    // Default provider (.env of the cwd, which has no acme-hq tokens): pending path.
    expect(await registration.factory()).toBeNull();
    expect(registerPendingWebhookRoute).toHaveBeenCalledWith('slack/acme-hq');
  });
});

describe('createSlackBridge (env mode) — same construction from .env', () => {
  const originalCwd = process.cwd();

  function withEnv(lines: string[]): void {
    const dir = mkdtempSync(join(tmpdir(), 'slack-env-mode-'));
    writeFileSync(join(dir, '.env'), lines.join('\n') + '\n');
    process.chdir(dir);
  }

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('a named instance: legacy single-segment route, Socket Mode from its app token, pinned by SLACK_WORKSPACE_ID', async () => {
    withEnv(['SLACK_BOT_TOKEN_ALPHA=xoxb-alpha', 'SLACK_APP_TOKEN_ALPHA=xapp-alpha', 'SLACK_WORKSPACE_ID=T0SHARED']);
    const bridge = await slackInstanceBridgeFactory('alpha');
    expect(bridge?.instance).toBe('slack-alpha');
    const config = vi.mocked(createChatSdkBridge).mock.calls[0][0];
    expect(config).toMatchObject({ instance: 'slack-alpha', webhookPath: 'slack-alpha' });
    const adapter = config.adapter as unknown as { mode: string; routeSocketEvent: SocketRouterFn };
    expect(adapter.mode).toBe('socket');
    // Pinned: the shared workspace id drops another workspace's envelope.
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const ack = vi.fn(async () => {});
    await adapter.routeSocketEvent({ team_id: THEIRS, event: {} }, 'events_api', ack);
    expect(ack).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ workspaceId: 'T0SHARED' }));
  });

  it('SLACK_WORKSPACE_ID_<NAME> pins one instance over the shared value; the default app reads the bare keys', async () => {
    withEnv([
      'SLACK_BOT_TOKEN=xoxb-default',
      'SLACK_SIGNING_SECRET=sig-default',
      'SLACK_BOT_TOKEN_ALPHA=xoxb-alpha',
      'SLACK_SIGNING_SECRET_ALPHA=sig-alpha',
      'SLACK_WORKSPACE_ID=T0SHARED',
      'SLACK_WORKSPACE_ID_ALPHA=T0ALPHA',
    ]);
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const alpha = await createSlackBridge({ instanceKey: 'slack-alpha' });
    expect(alpha?.instance).toBe('slack-alpha');
    const alphaAdapter = vi.mocked(createChatSdkBridge).mock.calls[0][0].adapter as unknown as {
      mode: string;
      handleWebhook: (r: Request) => Promise<Response>;
    };
    expect(alphaAdapter.mode).toBe('webhook');
    await alphaAdapter.handleWebhook(signed(eventCallback('T0SHARED'), 'application/json', 'sig-alpha'));
    expect(log.warn).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ workspaceId: 'T0ALPHA' }));

    const dflt = await createSlackBridge();
    expect(dflt?.instance).toBeUndefined();
    expect(vi.mocked(createChatSdkBridge).mock.calls[1][0]).toMatchObject({
      instance: undefined,
      webhookPath: 'slack',
    });
  });

  it('unpinned when no workspace id is configured, and null when the bot token is missing', async () => {
    withEnv(['SLACK_BOT_TOKEN=xoxb-default', 'SLACK_SIGNING_SECRET=sig-default']);
    const dflt = await createSlackBridge();
    expect(dflt).not.toBeNull();
    const adapter = vi.mocked(createChatSdkBridge).mock.calls[0][0].adapter as unknown as {
      routeSocketEvent: unknown;
    };
    // Not wrapped: still the prototype's router.
    expect(adapter.routeSocketEvent).toBe(
      (SlackAdapter.prototype as unknown as { routeSocketEvent: unknown }).routeSocketEvent,
    );

    expect(await createSlackBridge({ instanceKey: 'slack-missing' })).toBeNull();
    expect(registerPendingWebhookRoute).not.toHaveBeenCalled(); // env mode never holds routes
  });
});
