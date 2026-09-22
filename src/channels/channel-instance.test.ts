/**
 * The adapter-instance seam in channel-registry.ts: a ChannelInstanceSpec is
 * validated, turned into a registration by its channel type's instance
 * factory, started with the existing hot-start entry, stopped one at a time
 * with stopChannelAdapter, and removed with unregisterChannelAdapter. The
 * default boot path (initChannelAdapters over self-registered factories) is
 * untouched by all of this.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';
import type { ChannelInstanceSpec } from './channel-registry.js';

function createFakeAdapter(
  channelType: string,
  instance?: string,
): ChannelAdapter & { setupCount: number; teardownCount: number } {
  const fake = {
    name: instance ?? channelType,
    channelType,
    instance,
    supportsThreads: false,
    setupCount: 0,
    teardownCount: 0,
    async setup(_config: ChannelSetup) {
      fake.setupCount += 1;
    },
    async teardown() {
      fake.teardownCount += 1;
    },
    isConnected() {
      return fake.setupCount > fake.teardownCount;
    },
    async deliver() {
      return undefined;
    },
  };
  return fake;
}

const setupFn = (): ChannelSetup => ({
  onInbound() {},
  onInboundEvent() {},
  onMetadata() {},
  onAction() {},
});

const ACME: ChannelInstanceSpec = {
  instance: 'acme-hq',
  channelType: 'slack',
  externalScope: 'T02AXK3',
  transport: 'webhook',
  webhookPath: '/webhook/slack/acme-hq',
};

describe('webhook paths derived from a spec', () => {
  it('default instance keeps /webhook/<type>; a named instance gets /webhook/<type>/<instance>', async () => {
    const { defaultWebhookPath, webhookRoutingPath } = await import('./channel-registry.js');
    expect(defaultWebhookPath({ channelType: 'slack', instance: 'slack' })).toBe('/webhook/slack');
    expect(defaultWebhookPath({ channelType: 'teams', instance: 'acme' })).toBe('/webhook/teams/acme');
    expect(webhookRoutingPath({ channelType: 'slack', instance: 'slack' })).toBe('slack');
    expect(webhookRoutingPath({ channelType: 'slack', instance: 'acme-hq' })).toBe('slack/acme-hq');
  });

  it('honours the path a spec names (env-mode instances keep their legacy single segment) and rejects other shapes', async () => {
    const { webhookRoutingPath } = await import('./channel-registry.js');
    expect(
      webhookRoutingPath({ channelType: 'slack', instance: 'slack-alpha', webhookPath: '/webhook/slack-alpha' }),
    ).toBe('slack-alpha');
    expect(webhookRoutingPath(ACME)).toBe('slack/acme-hq');
    for (const bad of ['/hooks/slack/x', '/webhook/', '/webhook/a/b/c', '/webhook/a b', '/webhook/a?x', 'slack/x']) {
      expect(() => webhookRoutingPath({ ...ACME, webhookPath: bad })).toThrow(/webhookPath/);
    }
  });
});

describe('validateChannelInstanceSpec', () => {
  it('accepts the contract shape with and without the optional fields', async () => {
    const { validateChannelInstanceSpec } = await import('./channel-registry.js');
    expect(() => validateChannelInstanceSpec(ACME)).not.toThrow();
    expect(() =>
      validateChannelInstanceSpec({ instance: 'slack', channelType: 'slack', transport: 'socket' }),
    ).not.toThrow();
  });

  it('rejects unsafe keys, unknown transports, empty scopes and bad paths', async () => {
    const { validateChannelInstanceSpec } = await import('./channel-registry.js');
    expect(() => validateChannelInstanceSpec({ ...ACME, instance: 'a/b' })).toThrow(/URL-safe/);
    expect(() => validateChannelInstanceSpec({ ...ACME, instance: '' })).toThrow(/URL-safe/);
    expect(() => validateChannelInstanceSpec({ ...ACME, transport: 'polling' as 'webhook' })).toThrow(/transport/);
    expect(() => validateChannelInstanceSpec({ ...ACME, externalScope: '' })).toThrow(/externalScope/);
    expect(() => validateChannelInstanceSpec({ ...ACME, webhookPath: '/x' })).toThrow(/webhookPath/);
    expect(() => validateChannelInstanceSpec({ ...ACME, channelType: 'sl ack' as 'slack' })).toThrow(/channelType/);
  });
});

describe('registerChannelInstance → startChannelAdapter → stopChannelAdapter', () => {
  // Module-level maps (registry, active adapters, instance factories, specs,
  // captured setupFn) — fresh module per test.
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { teardownChannelAdapters } = await import('./channel-registry.js');
    await teardownChannelAdapters();
    vi.resetModules();
  });

  it("builds the registration through the channel type's instance factory and starts it post-boot", async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(setupFn); // boot with nothing registered
    const seen: ChannelInstanceSpec[] = [];
    const adapter = createFakeAdapter('slack', 'acme-hq');
    reg.registerChannelInstanceFactory('slack', (spec) => {
      seen.push(spec);
      return { factory: () => adapter };
    });

    reg.registerChannelInstance(ACME);
    expect(seen).toEqual([ACME]);
    expect(reg.getRegisteredChannelNames()).toContain('acme-hq');
    // The stored spec is a copy: a caller mutating its own object later
    // cannot change what the registry believes it registered.
    const stored = reg.getChannelInstanceSpec('acme-hq');
    expect(stored).toEqual(ACME);
    expect(stored).not.toBe(ACME);
    expect(reg.listChannelInstanceSpecs()).toEqual([ACME]);

    await expect(reg.startChannelAdapter('acme-hq')).resolves.toBe('started');
    expect(reg.getChannelAdapterExact('acme-hq')).toBe(adapter);
    expect(adapter.setupCount).toBe(1);
  });

  it('throws when no instance factory exists for the channel type (adapter not installed)', async () => {
    const reg = await import('./channel-registry.js');
    expect(() => reg.registerChannelInstance({ ...ACME, channelType: 'teams' })).toThrow(
      /no instance factory for channel type 'teams'/,
    );
    expect(reg.getChannelInstanceSpec('acme-hq')).toBeUndefined();
  });

  it('validates before touching the registry', async () => {
    const reg = await import('./channel-registry.js');
    reg.registerChannelInstanceFactory('slack', () => ({ factory: () => null }));
    expect(() => reg.registerChannelInstance({ ...ACME, instance: 'bad key' })).toThrow(/URL-safe/);
    expect(reg.getRegisteredChannelNames()).not.toContain('bad key');
  });

  it('stopChannelAdapter tears one instance down, keeps its registration for a restart, and reports not-active after', async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(setupFn);
    const sibling = createFakeAdapter('slack', 'other');
    reg.registerChannelAdapter('other', { factory: () => sibling });
    await reg.startChannelAdapter('other');

    let built = 0;
    const adapters: ReturnType<typeof createFakeAdapter>[] = [];
    reg.registerChannelInstanceFactory('slack', () => ({
      factory: () => {
        built += 1;
        const a = createFakeAdapter('slack', 'acme-hq');
        adapters.push(a);
        return a;
      },
    }));
    reg.registerChannelInstance(ACME);
    await reg.startChannelAdapter('acme-hq');

    await expect(reg.stopChannelAdapter('acme-hq')).resolves.toBe('stopped');
    expect(adapters[0].teardownCount).toBe(1);
    expect(reg.getChannelAdapterExact('acme-hq')).toBeUndefined();
    // Siblings keep running; the registration and spec survive the stop.
    expect(reg.getChannelAdapterExact('other')).toBe(sibling);
    expect(sibling.teardownCount).toBe(0);
    expect(reg.getRegisteredChannelNames()).toContain('acme-hq');
    expect(reg.getChannelInstanceSpec('acme-hq')).toEqual(ACME);

    await expect(reg.stopChannelAdapter('acme-hq')).resolves.toBe('not-active');
    await expect(reg.stopChannelAdapter('never-registered')).resolves.toBe('not-active');

    // A restart runs the factory again (fresh credentials, fresh adapter).
    await expect(reg.startChannelAdapter('acme-hq')).resolves.toBe('started');
    expect(built).toBe(2);
    expect(reg.getChannelAdapterExact('acme-hq')).toBe(adapters[1]);
  });

  it('stopChannelAdapter leaves a failing instance inactive and rethrows', async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(setupFn);
    const adapter = createFakeAdapter('slack', 'flaky');
    adapter.teardown = async () => {
      throw new Error('socket refused to close');
    };
    reg.registerChannelAdapter('flaky', { factory: () => adapter });
    await reg.startChannelAdapter('flaky');

    await expect(reg.stopChannelAdapter('flaky')).rejects.toThrow('socket refused to close');
    expect(reg.getChannelAdapterExact('flaky')).toBeUndefined();
  });

  it('unregisterChannelAdapter refuses an active instance, then removes the registration and its spec', async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(setupFn);
    reg.registerChannelInstanceFactory('slack', (spec) => ({
      factory: () => createFakeAdapter('slack', spec.instance),
    }));
    reg.registerChannelInstance(ACME);
    await reg.startChannelAdapter('acme-hq');

    expect(() => reg.unregisterChannelAdapter('acme-hq')).toThrow(/is active/);
    await reg.stopChannelAdapter('acme-hq');
    expect(reg.unregisterChannelAdapter('acme-hq')).toBe(true);
    expect(reg.getRegisteredChannelNames()).not.toContain('acme-hq');
    expect(reg.getChannelInstanceSpec('acme-hq')).toBeUndefined();
    expect(reg.unregisterChannelAdapter('acme-hq')).toBe(false);
    await expect(reg.startChannelAdapter('acme-hq')).rejects.toThrow(/no registration/);
  });

  it('re-registering a spec replaces the registration; the live instance changes at its next start', async () => {
    const reg = await import('./channel-registry.js');
    await reg.initChannelAdapters(setupFn);
    const scopes: Array<string | undefined> = [];
    reg.registerChannelInstanceFactory('slack', (spec) => ({
      factory: () => {
        scopes.push(spec.externalScope);
        return createFakeAdapter('slack', spec.instance);
      },
    }));
    reg.registerChannelInstance(ACME);
    await reg.startChannelAdapter('acme-hq');
    reg.registerChannelInstance({ ...ACME, externalScope: 'T0NEW' });
    expect(reg.getChannelInstanceSpec('acme-hq')?.externalScope).toBe('T0NEW');
    await expect(reg.startChannelAdapter('acme-hq')).resolves.toBe('already-active');
    await reg.stopChannelAdapter('acme-hq');
    await reg.startChannelAdapter('acme-hq');
    expect(scopes).toEqual(['T02AXK3', 'T0NEW']);
  });
});
