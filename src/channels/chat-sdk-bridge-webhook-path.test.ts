/**
 * The bridge's inbound route for a connection-registered instance: the spec's
 * routing path (`slack/acme-hq`) replaces the instance key as the URL under
 * `/webhook/`, and teardown releases just that route through the disposer
 * registerWebhookAdapter hands back — so one instance can stop while its
 * siblings keep serving. Without webhookPath the route is byte-identical to
 * before (instance key, or the platform name for the default instance).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';

const { disposer } = vi.hoisted(() => ({ disposer: vi.fn() }));

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(() => disposer),
}));

import { registerWebhookAdapter } from '../webhook-server.js';

function stubAdapter(name: string): Adapter {
  return { name, initialize: async () => {} } as unknown as Adapter;
}

const hostConfig = {
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  runMigrations(initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  closeDb();
  vi.clearAllMocks();
});

describe('createChatSdkBridge — webhookPath', () => {
  it('registers the spec routing path instead of the instance key, and releases it on teardown', async () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter('slack'),
      instance: 'acme-hq',
      webhookPath: 'slack/acme-hq',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);

    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack'); // handler key stays the SDK adapter name
    expect(routingPath).toBe('slack/acme-hq');
    expect(bridge.instance).toBe('acme-hq');
    expect(disposer).not.toHaveBeenCalled();

    await bridge.teardown();
    expect(disposer).toHaveBeenCalledTimes(1);
    // Idempotent: a second teardown does not dispose twice.
    await bridge.teardown();
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it('without webhookPath the route is the instance key; the default instance keeps the platform name', async () => {
    const named = createChatSdkBridge({
      adapter: stubAdapter('slack'),
      instance: 'slack-alpha',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    expect(vi.mocked(registerWebhookAdapter).mock.calls[0].slice(1)).toEqual(['slack', 'slack-alpha']);
    await named.teardown();

    const dflt = createChatSdkBridge({ adapter: stubAdapter('slack'), supportsThreads: true });
    await dflt.setup(hostConfig);
    expect(vi.mocked(registerWebhookAdapter).mock.calls[1].slice(1)).toEqual(['slack', 'slack']);
    await dflt.teardown();
    expect(disposer).toHaveBeenCalledTimes(2);
  });

  it('tolerates a webhook server that hands back no disposer (older copies, test doubles)', async () => {
    vi.mocked(registerWebhookAdapter).mockReturnValueOnce(undefined as unknown as () => void);
    const bridge = createChatSdkBridge({
      adapter: stubAdapter('slack'),
      instance: 'slack-beta',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await expect(bridge.teardown()).resolves.toBeUndefined();
    expect(disposer).not.toHaveBeenCalled();
  });

  it('rejects a webhookPath that is not one or two URL-safe segments, at construction', () => {
    for (const bad of ['a/b/c', 'a b', '', '/slack/x', 'slack/x?y', 'slack:x']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter('slack'), instance: 'x', webhookPath: bad, supportsThreads: true }),
      ).toThrow(/webhookPath/);
    }
  });
});
